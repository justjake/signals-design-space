# Two-tier graph rebuild: watched push discipline over unwatched validAt-gated pull

Design for rebuilding `src/graph.ts` so the WATCHED tier (nodes with observers,
plus everything on a path between a watched node and its transitive
dependencies) runs the full alien-signals edge discipline, while the UNWATCHED
tier keeps the existing validAt-gated pull validation. The tiering itself is decided;
this document fixes the concrete mechanics. Reference implementation: the
verbatim alien-signals core at `upstream-alien-signals/src/system.ts`. All fx2
line numbers cite `src/graph.ts` at commit `8072ddd` unless another file is
named.

STATUS: LANDED, together with the ResolvedState merge (section 11, an
owner-decided amendment sharing the same read-path surgery). Three deltas
between this design and the as-built code, each found by the tests and
documented inline where the design said something else:

Sections 1-10 preserve the names used by the historical `8072ddd` design.
Section 13 maps them to the current `Atom`/`Computed` vocabulary.

- pass-id uniqueness (section 2): the case-3 dedup probe requires eval pass
  ids that are NEVER reused; the pre-existing restore discipline recycles
  values, so new ids come from a monotonic counter (`evalPassCounter`) behind
  the pass-scoped `evalPass`;
- never-computed exemption (section 6, step 5): pending-edge delivery skips
  nodes with `version === 0` — born-Dirty, no dep edges, so no wave was ever
  swallowed and there is no missed edge to deliver;
- T12's tail (section 8): the skeleton's expectation was wrong — after the
  subscribe-eval trims the unread suffix, the NEXT pull legitimately re-reads
  it and re-promotes the dropped dep.

Verification stance, per standing orders:

- behavioral changes are falsify-first — two defects are already captured
  failing below, outputs quoted;
- pure-parity refactors are gated by the suites (265 tests, 1200-seed oracle,
  battery 24/1-exempt, gc-leaks);
- every section labels which regime it is in.

## 1. Current-state map: fx2 vs alien

What fx2 already has, what alien has, and the deltas this rebuild closes.

| Concern | alien (`system.ts`) | fx2 (`graph.ts`) | Delta |
| --- | --- | --- | --- |
| Node record | `ReactiveNode` lines 1-7: four list heads + flags | lines 73-109: same heads + `observerCount`, `validAtGraphChange` (then on the shared record), value `version`, the React snapshot counters, `worldMemos`, `causeEvent` | none (fx2 is a superset) |
| Link record | lines 9-17: both lists doubly linked; `version` is a tracking-pass marker | lines 59-71: deps singly linked (`nextDep` only), subs doubly linked, `inSubs`, `evalPass`, `version` | naming collision + threading decision, section 2 |
| link() protocol | 4 cases, lines 51-91: tail repeat (52-54), `nextDep` in-place reuse (56-61), `subsTail` same-pass dedup (62-65), create + thread both lists (66-90) | `trackRead` lines 321-350: has cases 1 (323, pass-guarded), 2 (325-329), 4 minus subs install for unwatched subs (330-349) | case 3 missing: non-adjacent re-read in one pass creates a duplicate edge |
| Trim after eval | per-link `unlink()` (93-116), fires `unwatched()` when `dep.subs` empties (112-114) | `trimDeps` (353-367): suffix truncation + `unlinkFromSubs`/`removeObserver` per watched edge | equivalent; fx2 keys teardown on `observerCount` 1→0 (303-318), not subs emptiness, because the lifetime-effect machinery keys on the count |
| Propagate | iterative, explicit stack, flag protocol with `RecursedCheck`/`Recursed` reentrancy bits (118-174) | recursive `mark()` (402-422): Check-only marking, causeEvent, snapshot-counter bumps on Clean→Check (416-417), watcher scheduling (404-406, 424-432) | recursion → stack bound on deep chains; traversal-bit decision, section 3 |
| Pull validation | iterative `checkDirty` (176-237) resolving Pending via `update()` + `shallowPropagate` (239-250) | recursive `ensureFresh` (760-783): version comparison per edge; no shallowPropagate | deliberate divergence, section 5 |
| Watched/unwatched boundary | single-tier: every edge always in both lists | already two-tier: `inSubs` per edge, `addObserver`/`removeObserver` cascades (290-318), `validAtGraphChange` vs the global `GraphChangeClock` (764) | promote does not validate — two verified defects, section 6 |
| Async, worlds, tracer, clocks | absent | threaded through the same nodes | must survive unchanged, section 8 |

The name collision to keep straight: alien's `Link.version` is a
tracking-pass marker and corresponds to fx2's `Link.evalPass`. fx2's
`Link.version` (the dependency's value generation captured at last read) has
no alien equivalent — alien's ground truth is flags plus `update()`, fx2's is
versions. One name per concept; fx2's names stay.

### Verified promote defects (falsify-first anchors)

Probe A — value plane. Read a computed unwatched, write its dependency (no
back-edges, so no push mark), subscribe without pulling (`observeNode`,
lines 995-1023, deliberately links without evaluating), then read.
`ensureFresh`'s watched fast path (761-763) trusts the stale Clean flags:

```
AssertionError: expected 2 to be 4   // d = a*2 after a.set(2); d.get() served 2
```

Probe B — notification plane. Dispose an effect over a computed (demote seeds
Check, line 313), subscribe a leaf, write the dependency. `mark()`
early-returns on the pre-existing Check without descending (403-407), so the
new subscriber is never scheduled and the uSES snapshot counter (today's
`storeVersion`) never advances:

```
AssertionError: expected +0 to be 1  // notify count after the write
```

Both share one cause: promote installs back-edges and flag trust without
establishing that the flags deserve trust. Section 6 fixes both.

### Verified notification contract (pinned, parity)

Leaf notification is edge-triggered on the observed node's Clean→stale
transition; a pull re-arms it. Probe: subscribe to `d = a*2`, evaluate once,
then `a.set` twice with no pull between, then pull and write again:

```
{ afterFirst: 1, afterSecond: 1, afterThird: 2 }
```

The rebuild keeps this contract and extends it to late subscribers: arriving
at an already-stale node means the edge you care about already fired (or,
stale-Clean, could never fire), so promote delivers the pending edge once at
subscribe time. React bindings tolerate the wake by construction — notify
leads to a snapshot compare, and the store version is unchanged.

## 2. Link layout

Decision: **no new fields; deps stay singly linked**. The record remains

```ts
interface Link {
  dep: ReactiveNode;
  sub: ReactiveNode;
  version: NodeVersion;      // dep.version at last read through this edge
  nextDep: Link | undefined; // deps list: singly linked, first-read order
  prevSub: Link | undefined; // subs list: doubly linked
  nextSub: Link | undefined;
  inSubs: boolean;           // present in dep's subs list (watched edges only)
  evalPass: number;          // eval-pass reading (alien's Link.version role)
}
```

One record for both tiers, no per-edge representation polymorphism (a prior
experiment measured a -9% broad regression from polymorphic edges); an
unwatched edge is the same object with `inSubs === false` and no subs-side
threading.

Justification for omitting `prevDep` (the owner-sanctioned alternative to
adding it): every deps-list mutation in either tier is one of

- append at tail — `trackRead` 340-342;
- in-place reuse at the `depsTail` cursor — 325-329;
- suffix truncation after `depsTail` — `trimDeps` 353-367, O(1) per dropped
  link because the suffix is wholly discarded and the subs side already has
  `prevSub`/`nextSub` for its O(1) unlink;
- whole-list drop — `unlinkAllDeps` 928-941.

No mid-list single-dep removal exists: promote installs back-edges (subs
side), demote removes back-edges (subs side, doubly linked). In alien,
`prevDep` serves `unlink()` mid-list integrity and the backward walk in
`isValidLink` (252-261) — and `isValidLink` exists solely to serve the
`Recursed` reentrancy protocol, which section 3 declines. If a future change
needs mid-list dep unlink, adding `prevDep` is mechanical at three sites
(`trackRead` create, `trimDeps`, `unlinkAllDeps`).

`trackRead` gains alien's case 3 (same-pass dedup): before creating a new
link, probe `dep.subsTail`:

```ts
const ps = dep.subsTail;
if (ps !== undefined && ps.sub === sub && ps.evalPass === evalPass) return ps;
```

This works for the same reason alien's does: cases 1/2 re-mark on reuse
(line 327) and new links carry the current pass id, so a non-adjacent re-read
finds its own earlier link at the dep's subs tail. It only fires for watched
subs (unwatched edges never enter subs lists); unwatched non-adjacent
re-reads keep today's tolerated duplicate forward edges — version-consistent,
forward-only garbage. [behavioral for watched edge counts → falsify-first,
test T9]

**As-built addition — pass-id uniqueness.** The probe's soundness argument is
"a pass match means this edge was marked by the pass in progress, therefore
it sits inside the kept prefix". That implication needs pass VALUES that are
never reused, and the pre-existing discipline reuses them: every eval's
`finally` restores `evalPass = myPass`, so after an outer eval completes,
the global sits below values its nested evals used, and a later pass can
hand out one of those values again. A recycled value could match an edge
from a dead pass whose position is outside the kept prefix; trackRead would
return it without advancing the cursor, and trimDeps would then truncate a
dependency the evaluation genuinely read — a silently missing edge. Fix:
new ids come from a monotonic `evalPassCounter` (`newEvalPass()`), while
`evalPass` keeps the exact same pass-scoped restore behavior. Comparisons
are equality-only, so nothing else observes the value change.

**As-built update — edges are evaluation-only.** The one non-evaluation edge
source, `adoptDepLink` (the hidden refetch-nonce edge, appended with
`evalPass: 0`), was deleted with the refresh() API. The pass-0 class the dedup
probe had to coexist with — edges sitting in a deps list that no evaluation
read — no longer exists, so the invariant is now unconditional: **a
derived's deps list is exactly what its last evaluation read, in read
order.** Every edge is created or re-marked inside the evaluation that read
it, and pass ids assigned during a pass (including by nested evals) are all
`>= myPass` under the monotonic counter, so the invariant has a mechanical
shadow: after `trimDeps`, every retained link satisfies
`l.evalPass >= myPass`. The invariant is checked from the test suite (a deps-list walk in graph-tiers.spec.ts) rather than by a shipped assertion, per the owner's rule that invariant nets live in tests. Flag bit allocation

Exact constants, extending the documented layout at lines 30-57:

```ts
export const enum Flag {
  Cell             = 0b0000_0001, // node type: writable source
  Derived          = 0b0000_0010, // node type: cached computed
  Watcher          = 0b0000_0100, // node type: effect or leaf observer
  Check            = 0b0000_1000, // staleness: possibly stale; confirm dep versions
  Dirty            = 0b0001_0000, // staleness: must recompute on next pull
  Watched          = 0b0010_0000, // tier: back-edges installed, push marks trustworthy
  DerivedError     = 0b0100_0000, // async: latest eval threw; ErrorBox in node.throwable
  DerivedSuspended = 0b1000_0000, // async: latest eval parked; Suspension in node.throwable
  StaleMask = Check | Dirty,
  AsyncMask = DerivedError | DerivedSuspended,
}
export type Flags = Brand<number, 'Flags'>; // the stored word (see graph.ts)
```

(The rebuild landed these as an erasable const object; the later hygiene
round converted them to the `const enum` above and branded the stored
word — same bits, same table.)

The two async bits are the ResolvedState merge's exclusive value-plane field
(section 11): clear-then-set discipline exactly like `Flag.StaleMask`,
both-clear is the plain-value state, `Flag.AsyncMask` is the read protocol.

`Watched` semantics:

- cells/deriveds: mirror of `observerCount > 0`, set in promote (0→1),
  cleared in demote (1→0). `observerCount` stays authoritative — lifetime
  effects and demote need the count; the flag is the one-load hot-path test;
- watchers: set at creation, cleared in `disposeWatcher` before
  `unlinkAllDeps`. This collapses `trackRead`'s two-branch watched test
  (343-344) and `ensureFresh`'s `observerCount` load (761) into
  `(flags & Flag.Watched) !== 0`;
- debug assertion (dev builds/tests): for non-watchers,
  `Watched ⟺ observerCount > 0`.

Alien traversal bits **not adopted** — `RecursedCheck` (4) and `Recursed`
(8):

- alien needs them to keep flag-only invalidation precise when a wave reaches
  a node that is mid-tracking; fx2's recompute trigger is versions, and a
  mark landing on a computing node is overwritten by `recompute`'s exit rule
  (self-affecting evaluations stay Dirty via the pre-eval clock comparison,
  728-755);
- watcher re-run precision comes from `runWatcher`'s version validation
  (849-864), not from mark-time flag distinctions;
- the wave's visited test is the Clean→Check transition itself; already-stale
  nodes are covered by the stale-cover invariant (section 4);
- declining them also removes the only consumer of `prevDep` (section 2).

`0b1_0000_0000` and above remain reserved.

## 4. Propagate adaptation (push down on write)

Replace recursive `mark()` (402-422) with an iterative traversal in alien's
shape — a link cursor plus an explicit stack of suspended `nextSub` positions
(`system.ts` 118-174) — keeping fx2's per-node visit rules exactly:

1. already stale → if Watcher and unscheduled, re-schedule (today's 404-406);
   do not descend;
2. Clean → set **Check only** (never Dirty), record `causeEvent`. Readings,
   not marks, are the recompute trigger. Atom readings never move backward:
   a write-then-revert may cost validation or recomputation, which is required
   if a computed cached the intermediate value inside the batch;
3. Watcher → `scheduleWatcher` (markedLeaves vs watcherQueue split unchanged,
   424-432); do not descend;
4. Derived → bump the global validation clock and the node's uSES snapshot
   counter (the latter unless suppressed — silent draft folds, 377-394);
   descend into its subs.

Call sites: `propagateFrom` (435-440) and `invalidateDerived` (447-458) route
their subs loops through the shared traversal; flush discipline
(`batchDepth === 0` → `flush()`) unchanged. The snapshot-counter bump must
happen exactly once per wave per derived (the Clean→Check transition), same
as today — uSES snapshots are contract.

**Stale-cover invariant** (named, load-bearing): for every watched edge,
*dep stale ⇒ sub is stale or scheduled*. Visit rule 1's early-return is sound
only under it. Today it holds for edges created by evaluation — `readCell`/
`readDerived` freshen the dep before `trackRead` links — and is violated by
pull-less linking (`observeNode` 995-1023, promote's cascade). The rule:
**any site installing a back-edge onto a stale dep applies the visit rules to
the sub**. Promote (section 6) is the sole enforcement point: evaluation is
the only other site that creates dep edges, and it freshens the dep before
linking.

`pokeLeafObservers` / `pokeAndWakeLeafObservers` (467-526) are **not**
converted: they are worlds-overlay traversals with different marking (leaf
Dirty only, no derived staleness) and Set-based dedup. Their reachability
contract — watched derived edges down to leaf watchers — is preserved because
promote/demote maintain the identical subs-closure invariant that
`addObserver`/`removeObserver` maintain today. Their recursion depth is a
pre-existing bound; converting them is follow-up if benchmarks demand.
[parity: iterative propagate is a pure-shape refactor gated by suites; the
stale-cover enforcement is behavioral and falsify-first via probes A/B]

## 5. checkDirty adaptation (pull up on read)

`ensureFresh` (760-783) keeps its shape and its exact-recompute-count
contract. Where fx2 deliberately diverges from alien, and why:

- **Check ≈ Pending, but resolution differs.** Alien resolves Pending by
  running `update()` inside `checkDirty` and converting sibling Pending→Dirty
  via `shallowPropagate` (239-250), because flags are its only truth. fx2
  resolves Check by comparing `l.version` to `dep.version` after recursively
  freshening derived deps — no flag conversion, no shallowPropagate. Each
  consumer independently detects "dep actually changed" through its own edge
  version at its own pull; a dep that recomputed to an equal value cuts off
  every consumer without any sibling walk.
- **Watcher notify timing.** Alien notifies some Watching subs from
  `shallowPropagate`; fx2 schedules watchers eagerly at mark time and
  validates at run (`runWatcher` 849-864). Both end at "effect re-runs iff a
  dep value actually changed"; fx2's exact counts stay the contract.
- **Dirty producers are exhaustive and unchanged:** computed-node creation,
  `invalidateDerived` — thenable settlement treated as
  a write (447-458), self-affecting evaluations (`recompute` exit
  rule, 755), and poke marking of leaf watchers only (475, 509). Alien's
  "signal write sets its own Dirty" has no fx2 equivalent: cells carry
  versions (`writeCell` 673-690), not staleness.
- **Tier fast paths:** watched → Clean returns immediately (761-763, flags
  trustworthy under the stale-cover invariant); unwatched → Clean plus
  `validAtGraphChange === graphChangeClock` returns immediately (764) — the
  quiet-read O(1) short-circuit that justifies the unwatched tier.
- **Async/pending threads through untouched.** A parked evaluation returns
  through `finishComputeImpl` (asyncs.ts 170-198): the version advances so
  downstream re-pulls and parks on the Suspension; the async machine (the
  `DerivedError`/`DerivedSuspended` flag field plus `node.throwable` after
  the section-11 merge) is value-plane and invisible to the staleness walk.
  Settlement is a write: `invalidateDerived` plus eager `ensureFresh` under
  a batch (asyncs.ts 122-146). Suspension identity/reuse rules (asyncs.ts
  153-168; worlds.ts 517-520) do not change. The up-walk treats a pending
  derived like any other node — version comparisons only.
- **Recursion stays, consciously.** Alien's iterative `checkDirty`
  interleaves `update()` — user code — in its loop; converting fx2's
  recompute-in-walk the same way is a larger change with its own
  falsification burden. Deep pull chains keep today's stack bound; the
  deep-chain benchmark gates whether the iterative conversion becomes
  follow-up work.

[parity throughout; no semantic change on the pull side — the 1200-seed
oracle is the referee]

## 6. Promote and demote

### Promote — first observer arrives (subscription or watched-eval link time)

Rewrites `addObserver` (290-301). Fixes probes A and B.

1. `node.observerCount++`; continue only on 0→1.
2. `node.flags |= Watched`.
3. If Derived, walk `node.deps` in list order; for each link `l`:
   a. `linkIntoSubs(l)` — install the back-edge (266-275 unchanged);
   b. `promote(l.dep)` — depth-first over the reachable dep closure. Cycles
      are impossible: dep edges exist only after an evaluation, and cyclic
      evaluation throws (721);
   c. version-validate the edge once:
      `edgeFresh := l.version === l.dep.version && (dep is a Cell || dep is Clean after its promote)`.
      The version match alone is insufficient — a stale-unwatched dep has not
      recomputed, so its version cannot have moved even if its own inputs did;
      the dep's post-promote flags carry that information up.
4. Seed staleness: if node was Clean and any edge failed validation →
   `flags |= Check`. Dirty stays Dirty; `asyncState` untouched (value-plane).
   Where every edge validated, Clean stands — push marks are trustworthy from
   this instant, and the watched fast path is sound (fixes probe A).
5. Pending-edge delivery: after the cascade returns, the top-level linker
   (`observeNode` — the one pull-less linking site; evaluation-created edges
   freshen the dep first) checks the freshly linked dep; if it is stale,
   apply the propagate visit rules to the subscriber — for a leaf with
   `onNotify`, that schedules one wake, delivered at the next flush
   (`observeNode` flushes when `batchDepth === 0`). This restores the
   stale-cover invariant for the new edge and gives late subscribers the
   staleness edge they missed (fixes probe B). Edge-triggered semantics are
   preserved: one wake, pull re-arms.

   **As-built exemption:** never-computed nodes (`version === 0`) deliver
   nothing. They are born Dirty with an empty deps list, so no watched
   back-edge exists below them that could have early-returned a wave, and
   the subscriber has no previous view to be stale against — the
   edge-triggered contract's "no Clean→stale transition happened yet".
   Without the exemption, every subscribe-before-first-pull (T11's
   incremental build; `useIsPending` over a cold computed) pays a spurious
   wake. React tolerated it (version-unchanged snapshot compare), but the wake
   was semantically wrong, and T11 caught it double-counting.
6. `noteLifetimeTransition(node)` — lifetime setup coalescing unchanged.
   (This step read `hooks.observation(node, true)` when the rebuild landed;
   the lifetime machinery has since been folded into graph.ts and the hook
   indirection deleted — promote and demote call the scheduler directly.)

Cost: O(edges in the newly watched closure), which promote already pays for
linking; validation adds two loads and a compare per edge. Promoting a node
mid-recompute (its deps list has an unmatched suffix beyond `depsTail`)
transiently links suffix edges; `trimDeps` unlinks them with symmetric
observer bookkeeping, as today (353-367).

### Demote — last observer leaves

Rewrites `removeObserver` (303-318).

1. `node.observerCount--`; continue only on 1→0.
2. `node.flags &= ~Watched`.
3. If Derived, for each dep link: `unlinkFromSubs(l)` (277-287), then
   `demote(l.dep)` — the cascade unlink of back-edges down the chain,
   symmetric with promote (counts increment once per watched sub edge and
   decrement once per removal).
4. validAtGraphChange seeding for the unwatched tier:
   - Clean at demote → `validAtGraphChange = graphChangeClock`. Sound:
     watched-Clean means no dependency changed since last validation (push
     marks were reliable), and "now" is the clock's reading; the next quiet
     read short-circuits O(1) instead of paying an up-walk.
   - stale at demote → `validAtGraphChange = 0`, forcing the up-walk on next
     read.
5. Drop the unconditional `Check` seeding (current line 313). Its job —
   distrust of flags across the boundary — moves to the two crossings that
   actually need it: promote validates on re-watch, and unwatched pulls never
   trust Clean without `validAtGraphChange`. (It was also insufficient: probe A's
   node was never previously watched, so demote seeding never covered it.)
6. `noteLifetimeTransition(node)` (originally `hooks.observation(node,
   false)`; same folding note as promote step 6).

Edge versions need no demote writes: `l.version` is maintained by
`recompute`/`readCell` in both tiers and is exactly the reading promote
validates.

Leak story (NEVER-LEAK rule): demote removes every back-edge promote's
closure installed; after demote a chain holds forward references only, so
dropping user handles collects the whole chain. Abandoned unwatched reads
never had subs-side registration (`trackRead`'s unwatched branch skips
`linkIntoSubs`), leaving plain forward garbage. The gc-leaks suite is
extended for the tier machinery (T7).

[steps 3-4 Clean case and step 5 are perf-affecting but semantics-neutral →
parity-gated plus recompute-count pin T6; steps 4-stale/5 interplay with
promote is behavioral → covered by falsify-first probes A/B]

## 7. What explicitly does NOT change

- **Worlds overlay**: drafts, rebase logs, replay, world memos and the
  quiescence sweep (worlds.ts throughout); `resolveEnvelope`/`draftEvaluate`
  render-time evaluation stays untracked under `graph.withWorld` — it creates
  no links and never touches the tiers.
- **`pokeAndWakeLeafObservers` / `pokeLeafObservers`** (467-526): code and
  call sites (worlds.ts 171, 237, 262; index.ts 496-500) untouched; their
  reachability semantics survive because the watched subs closure is
  maintained identically.
- **Async**: Suspension identity and reuse, ThenableBox, settlement-as-write,
  pending-forwards parking, stale serves (asyncs.ts entire; `readValue`
  index.ts 162-183).
- **Tracer hooks**: `hooks.trace` sites (today the `traceHook` module
  binding) and `causeEvent` threading — the iterative propagate carries the
  wave's cause exactly as `mark` does.
- **Lifetime effects**: the lifetime scheduler fires on the same 0↔1
  transitions with microtask coalescing (now `noteLifetimeTransition` in
  graph.ts; the `hooks.observation` seam over lifetime.ts at the time).
- **uSES snapshot counters**: every bump site preserved — `writeCell`
  (685-686), `invalidateDerived` (452-453), the Clean→Check derived bump in
  the wave (416-417), the loud discard-time bump (worlds.ts 262; today
  `bumpStoreVersionLoud`), and snapshot suppression for silent folds.
- **Batching and flush**: delivery is deferred until the outer batch ends;
  effects-settle-before-leaf-notify ordering and throwing-effect abort remain
  pinned.
- **Watcher lifecycle**: scope ownership and the dispose cascade. A later
  simplification removed FinalizationRegistry reclamation; effects, scopes,
  and subscriptions now require explicit disposal.
- **Public API**: zero signature changes in `index.ts` or
  `reactIntegration`; the React bindings under `src/react/` reference no
  graph internals (verified by grep) and are untouched. (Scoped to the tier
  rebuild alone. The ResolvedState merge, section 11, deliberately changes
  the read-protocol surface: `Envelope` → `ResolvedState`,
  `reactIntegration.resolveEnvelope` → `resolveState`, and the bindings'
  unwrap sites moved with it. `reactIntegration` itself was later dissolved
  by owner ruling: the react directory is part of the library, so the
  bindings import graph.ts/worlds.ts/tracer.ts directly and unwrap user
  handles at their own boundary with `nodeOf`.)

## 8. Test plan

New engine spec `tests/graph-tiers.spec.ts` plus a gc-leaks extension. Every
test labeled falsify-first (failing output captured pre-change) or parity
(suites are the evidence, structural asserts pin the shape).

- T1 falsify-first (output captured: `expected 2 to be 4`) — promote
  version-validates the value plane: unwatched read, write dep,
  subscribe-without-pull, read serves the fresh value.
- T2 falsify-first (output captured: `expected +0 to be 1`) — promote
  delivers the pending staleness edge: effect dispose (stale at demote),
  subscribe, one notify delivered at subscribe-time flush; a subsequent pull
  re-arms normally.
- T3 falsify-first — transitive validation: `c → d1 → d2` read unwatched,
  write `c`, subscribe `d2` without pull; `d2.get()` is fresh (Check seeded
  up the chain through step 3c).
- T4 parity — promote links transitively: subscribe a leaf over a 3-deep
  chain; assert `inSubs` on every closure edge, per-node `observerCount`,
  `Watched` set; unsubscribe reverses all of it.
- T5 parity — demote unlinks and seeds: after last-observer removal, subs
  lists empty down the chain, `Watched` cleared,
  `validAtGraphChange === currentGraphChange()` where Clean, `0` where stale.
- T6 parity (pin) — recompute counts across watch → demote → quiet-read
  cycles are unchanged, guarding the dropped Check seeding and the
  `validAtGraphChange` seeding.
- T7 parity (gc-leaks extension) — abandoned unwatched reads leave no
  back-edges: evaluate a chain unwatched, drop handles, WeakRef + gc asserts
  collection; structural sweep asserts zero subs entries. Add
  promote-then-demote-then-drop collection coverage for the tier machinery.
- T8 parity — quiet-read O(1) short-circuit preserved: after one validated
  unwatched read, repeat reads with no intervening write do zero recomputes
  anywhere in a wide instrumented graph and hit the
  `validAtGraphChange === graphChangeClock` return.
- T9 falsify-first — `trackRead` case-3 dedup: a watched consumer reading
  `a, b, a` in one evaluation ends with exactly one link to `a` (capture
  today's duplicate-edge count first).
- T10 parity (pin) — edge-triggered notify contract: two writes with no pull
  between deliver one notify; a pull re-arms
  (`{ afterFirst: 1, afterSecond: 1, afterThird: 2 }` verified today).
- T11 falsify-first — deep-chain propagate stack safety: a write through a
  deep watched chain (capture today's overflow depth first) completes under
  the iterative propagate.
- T12 parity — promote during evaluation: subscribing to a computing node
  with an unmatched deps suffix stays consistent after `trimDeps`.

As-built results, all in `tests/graph-tiers.spec.ts` (T7 in
`tests/gc-leaks.spec.ts`); every falsify-first output was captured against
the pre-rebuild graph in the landing session:

- T1 `expected 2 to be 4`, T2 `expected +0 to be 1`, T3
  `expected 20 to be 30`, T9 `expected 2 to be 1`, T11
  `RangeError: Maximum call stack size exceeded` (at depth 150 000) — all
  pass post-rebuild;
- T4/T5 fail pre-change on the structural asserts (`Flag.Watched`,
  validAtGraphChange seeding did not exist), pass post-rebuild; T6/T8/T10 parity pins
  pass on both sides;
- T12 as inherited from the skeleton asserted `readDerived(d) === 6` after
  the suffix trim; the correct expectation is `15` — the next pull
  re-evaluates the full body, re-reads `y`, and re-promotes it
  (`observerCount` back to 1, `Watched` set). The landed test pins the
  corrected behavior plus the tier invariant
  (`Watched ⟺ observerCount > 0` for non-watchers, `expectTierInvariant`),
  which is also this design's risk-2 mitigation;
- T7's remaining leak audit proves promote/demote cycling leaves zero
  subs-side entries and the demoted chain collects when dropped. The former
  dropped-subscription-handle test was removed with disposer finalization.

Gates for the landing commit (all run, all green): `npx tsc --noEmit`; full
suite 278 = 265 prior + 11 tier tests + 2 leak-audit extensions; deep oracle
`ROYALE_FX2_SEEDS=1200` (canaries intact); battery 24 passed / 1 failed
(DOM-mutation scenario 16 only — exempt).

## 9. Perf expectations by benchmark family

- **Deep watched chains, write-heavy** — alien's home turf; expect at-least
  parity with current fx2 (the push wave already exists) plus removal of
  per-level call overhead and the stack bound from iterative propagate.
  Versions keep recompute counts exact.
- **Diamonds** — recompute counts already optimal via version cutoff; case-3
  dedup shrinks subs lists (no duplicate edges), shortening waves. Modest
  gains.
- **Wide fanout** (one cell, many watched subscribers) — the wave is O(N)
  either way; markedLeaves batching unchanged. Expect neutral.
- **Quiet reads** (unwatched, read-heavy) — validAt-gated pull's home turf
  and the reason the unwatched tier exists: O(1) `validAtGraphChange`
  short-circuit vs alien's O(deps) per-read walk. Demote's Clean seeding removes the one-time
  post-demote up-walk. Gate: flat read cost vs graph depth.
- **Subscribe/unsubscribe churn** (mount storms, StrictMode double-mounts) —
  the new cost center: version validation adds two loads and a compare per
  closure edge on top of the linking promote already does. Expect
  noise-level; gate with coarse floors and no steady deopts, not per-edge
  pins.

Landed evidence (5-run medians, pre-change measured on the same session's
stash of `src/` — coarse floors, not pins): quiet reads 4.28 vs 4.18 ms/1e6
(parity), deep-chain 1k write+pull 7.44 vs 8.51 ms/200 (−13%), fanout-200
writes 18.66 vs 20.74 ms/2000 (−10%), promote/demote churn 35.7 vs 36.6
ms/2e5 (parity). `bench/react-bench.mjs` in line with the numbers recorded in REPORT.md
(transition p95 ~10.0 ms, mount-5000 median 57 ms vs baseline 69 ms).

## 10. Risks

1. Promote-time wake delivery is a behavior change for plain `observeNode`
   subscribers (one wake when subscribing to a stale node). React bindings
   tolerate it (version-unchanged snapshot compare), but battery and
   host-guarantees must confirm no commit-report ordering diffs.
2. Dropping demote's Check seeding makes promote validation the single line
   of defense; any future path that sets `Watched` without promote would
   resurrect the stale-Clean bug. Mitigation: the dev assertion
   `Watched ⟺ observerCount > 0` for non-watchers.
3. The iterative propagate must reproduce the snapshot-bump-exactly-once-
   per-wave rule; the oracle does not check store versions, so the React
   suites and host-guarantees are the referee for uSES snapshots.
4. `ensureFresh` stays recursive: deep pull chains keep stack exposure —
   consciously deferred, benchmark-gated.
5. `validAtGraphChange = graphChangeClock` at demote assumes watched-Clean implies
   fresh; poke paths mark only leaf watchers (475, 509) and worlds folds go
   through `writeAtom`, so no overlay path leaves a watched computed
   Clean-but-stale — T6 pins this.

## 11. ResolvedState merge (owner-decided amendment, landed with the rebuild)

The duplication being removed: `envelopeOf` (asyncs.ts) manufactured a fresh
Envelope record on EVERY base-state read — even the trivial value case — and
`resolveEnvelope`'s base atom path allocated the same wrapper; meanwhile
`node.asyncState` already encoded the same 3-state machine. One model
replaces both: node-resident state read through one protocol.

**The state view** — `ResolvedState` (asyncs.ts), which producer nodes satisfy
directly:

```ts
interface ResolvedState {
  flags: Flags;      // read via Flag.AsyncMask bits ONLY (node views carry more)
  value: unknown;    // UNINITIALIZED sentinel when no settled value exists
  throwable?: ErrorBox | Suspension | null; // present on async memo states
}
```

- Two flag bits in the MAIN node flags word (section 3): `DerivedError`
  0b0100_0000, `DerivedSuspended` 0b1000_0000; exclusive field with
  `Flag.AsyncMask`, clear-then-set exactly like `Flag.StaleMask`,
  both-clear = value state.
- Only `ComputedNode` keeps a stable `throwable` slot, initialized to `null`,
  because a computed can move between value, error, and suspended states.
  Atoms never set the async bits and omit the slot. Both still satisfy the
  state-view protocol directly, which deletes the base-world atom wrapper
  allocation. The computed slot stores the Suspension record, not its promise:
  nullable `.resolve` owns pendingness. A resolver permits identity reuse and
  performs settlement; `null` marks the suspension settled. The promise is what
  gets thrown. It stores the ErrorBox, not the error alone. Box identity
  preserves the rethrow-same-reference contract, and `sameError` reuse plus memo
  reconciliation compare through it.
- `node.asyncState` is deleted. Park/settle/error transitions
  (`baseUse`, `finishCompute`) are flag+slot writes preserving:
  suspension identity reuse while unsettled, sameError box reuse,
  settlement-behaves-like-a-write propagation.
- "stale" is DERIVED, not stored: stale ⇔ `value !== UNINITIALIZED`. Both
  prior build sites already defined it exactly that way
  (`!isUninitialized(node.value)`), so no information was lost; unwrap
  sites preserve the old normalize-to-undefined behavior via the sentinel
  check (`stateValue` in index.ts).
- WorldMemo records keep the second-resolution role. Plain records contain
  `{ flags, value }`; error and suspended records also carry `throwable`.
  `statesEqual` first reads `Flag.AsyncMask`, then compares the fields for that
  state, preserving `equals()`, suspension identity, and box identity exactly.
- `resolveEnvelope` → `resolveState`: the base world freshens the node
  (`peekAtom`/`ensureFresh`) and returns the node as the state view — zero
  allocation; drafted worlds return memo records as before.
  `unwrapForEval`, hooks' `unwrapState`, `latest`, `committed`,
  `isPendingPassive` all read the protocol: value → `value`; error → throw
  `(throwable as ErrorBox).error`; suspended → live drafts throw the
  promise, else stale serves, else throw.
- The `Envelope` type export is gone. `ResolvedState`, `Suspension`, `Flag`
  (with `Flag.AsyncMask`), and `isUninitialized` are the replacement
  protocol exports. `ErrorBox` and `isErrorBox` remain internal because
  only the engine and React bindings consume error snapshots.
- `committedSnapshot`'s per-call `{ engineErrorBox }` marker allocation is
  gone (it was also identity-unstable — a fresh object per `getSnapshot`
  call is a useSyncExternalStore hazard): the snapshot returns the ErrorBox
  itself, identity-stable for the whole error span, and `useCommitted`
  detects it with the class identity. The box itself is the brand; there is
  no parallel registry or marker field.

**What still allocates on reads, honestly:** drafted-world resolutions
allocate one memo record per (node, world-signature) per clock change
(amortized by the memo hit path), plus the world objects `worldOf` caches
per ids-array identity. Base-state reads — the hot path — allocate nothing.

**Verification stance:** parity-gated. The 278-test suite, the 1200-seed
oracle (whose `readWorld`/canary steps consume `resolveState` directly),
the battery, and the leak audit referee the merge; the no-alloc property
carries no dedicated test by owner ruling, this section stays honest about
the residual allocation sites instead.

## 12. Flush queue storage (as built, later round)

The two scheduling queues keep their backing stores across waves. `.length =
0` truncation makes V8 right-trim the backing store, so every wave re-grew
capacity from zero (O(log n) reallocations, garbage proportional to peak
wave width), and the leaf drain's splice snapshot added one array per wave.
As built:

- `effectQueue` (was `watcherQueue`) clears by logical length (`effectCount`);
  the `queueHead` drain cursor and the drain-time disposed tombstone
  (Watched clear, since the walk-modernization round) are unchanged
  (append-then-fully-drain, no mid-queue removal, no compaction).
- `renderNotifyQueue` (was `markedLeaves`) is double-buffered: a wave
  iterates its own buffer while
  re-marks from `onNotify` land in the spare, preserving the snapshot rule
  (a wave's iteration never sees entries added during delivery). A
  doubly-nested delivery finds the spare checked out and takes a fresh
  array — the rare frame pays the old per-wave allocation, never a
  clobbered iteration.
- The correctness price of retained capacity: every consumed slot is nulled
  at drain (drain loop, catch path, and leaf-delivery finally) — a
  soft-cleared slot must not pin a disposed watcher. Guarded by three
  `[guard]` gc-leaks tests and two delivery re-entrancy tests (Q1/Q2 in
  graph-tiers), each proven to bite against sabotaged variants.
- Two-stage flush ordering (effects settle before any leaf notify) and the
  throwing-effect abort semantics are unchanged.

Measured (bench/queue-probe.mts, 2000 subscribers x 50 waves, per-wave
heapUsed delta after forced GC): leaf-notify burst 244,280 -> 256 B/wave
median; effect burst 68,056 -> 256 B/wave median.

## 13. Walk modernization (as built, later round)

A later round reorganized the flags word and unified the walks; this
document's sections above describe the code at landing time. The mapping:

- Flag renames: `Cell`→`KindAtom`, `Derived`→`KindComputed`,
  `Watcher`→`Watching` (alien's name), `Check`→`StaleCheck`,
  `Dirty`→`StaleDirty`, `DerivedError`→`AsyncError`,
  `DerivedSuspended`→`AsyncSuspended`.
- New capability bits route dispatch (never callback presence):
  `WatchRender` (render-notify queue), `WatchRunEffect` (validated effect
  queue), `WatchDraft` (draft pings/wakes), and `WatchSchedule` (defer a
  validated effect body to its host phase). Component subscription =
  `Watching|WatchRender|WatchDraft`; engine effect = `Watching|WatchRunEffect`.
  The `scheduled`/`computing` bools became the `Scheduled`/`Computing` bits;
  the `disposed` bool is gone — watcher disposal is `Watching` set with
  `Watched` clear.
- `effectScope` no longer creates a watcher. Its `EffectOwner` contains only
  the existing `flags` and lazy `children` fields. `activeEffectOwner` points
  to it while the scope callback runs, or to an effect while that effect runs.
  Both collect nested effects through `children`; the shared `Watched` check
  prevents a self-disposed effect from accepting more.
- `pokeLeafObservers`/`pokeAndWakeLeafObservers` became ONE iterative
  `pokeDraftWatchers(node, cause, wake?)` sharing the wave's cursor +
  frame-stack skeleton, deduped by a per-node pokePass reading against the
  running walk's id (no allocation, no clearing — the EvalPass
  discipline). Poked watchers are marked `StaleCheck` for parity with the
  wave; the choice is arbitrary because render-notify watchers are never
  validated (flush clears staleness unconditionally before delivery). The
  walk threads `causeEvent` like the wave.
- The per-node uSES counter is now `storeVersion` — THE useSyncExternalStore
  snapshot; bump = subscribers re-render. Its base-clock companion (a second
  per-node counter that served the unscoped hook mode) is deleted with that
  mode: every provider-dependent hook now requires a
  `SignalsFrameworkProvider` and throws without one, so the silent-fold
  delivery channel is always the render-pass
  world. Settlement and discard bump through one helper
  (`bumpStoreVersionLoud`) that bypasses suppression: suppression exists
  only for silent draft folds, and those two carry information no render
  pass has shown.
- graph.ts carries a contract-matrix comment over the colocated walks
  (propagateWave, pokeDraftWatchers, writeAtom, invalidateComputed):
  rows = walks, columns = marks staleness / bumps storeVersion / schedules
  effects / schedules render subscribers / dedup mechanism.
- worlds.ts intents lost their write-only `seq` field (`OpSeq` died with
  it): the intent array IS dispatch order; retirement flips visibility,
  never position.
