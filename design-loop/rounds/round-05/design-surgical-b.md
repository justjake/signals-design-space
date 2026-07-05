# Round 5 design — surgical-b: route evaluator versions; delete the baseline fast-out

Status: final budgeted-round candidate. The complete normative design is the
round-4 champion, `rounds/round-04/synthesis.md`, with exactly the two
replacements in this file. No other round artifact is incorporated. All
round-4 text not explicitly replaced below remains normative.

Scope is intentionally closed to the round-5 docket: R1, R2, R3 (including
A/B/A), R4, R8, R9, R12, and the merged fork-test list. The two judge
blockers are repaired without a new mechanism: R1 generalizes the existing
evaluator probe from “is staged?” to “does the cached flattened evaluator
basis equal this world's effective versions?”, and R12's commit-baseline
fast-out is deleted. Added state: none. Deleted state: two
`commitBaseline` integers per root and their capture/lifecycle work.

---

## One page: the design that ships

The inherited engine has nine cooperating mechanisms. K0 is the closed,
packed donor kernel for the newest world. While a React bridge is registered,
every atom write appends a receipt on a per-atom tape; a render world selects
receipts by its immutable batch mask, global-sequence pin, and per-root lock
view, then replays them in write order. K1 is a separate packed graph holding
the real dependency edges discovered by non-newest evaluations. World memos
store values plus a closed validity basis: slot write clocks, visibility
stamps, exact flattened evaluator stamps, and the inherited suspense
fingerprints. Watchers receive value-blind `setState` calls synchronously in
the writer's execution context, so React supplies the writer's lanes.

Hook evaluators and reducers are world-scoped. A render stages them under a
lineage-stable stamp; F9 publishes only the hook version that actually becomes
current. Committed evaluator versions sit on the same global sequence line as
receipts, so an old pass resolves the version admitted by its pin. Round 4
made memo validation version-aware but left the K0 routing gate version-blind:
after K0 was recomputed under a newly promoted evaluator, an old pass could
serve that K0 value before reaching the version-aware memo ladder. The repair
uses the already-stored flattened evaluator vector as a mandatory exact
precondition for every K0 serve and every fixup fast-out; no bit, clock, walk,
or cache is added.

The mount fixup closes the render-to-subscribe window. Its round-4
`commitBaseline` optimization captured current committed currency immediately
before layout, then mistook equality with that newly captured currency for
proof that the earlier render used it. A retirement or cross-root promotion
can occur after the mounting render but before that capture, when no watcher
exists to receive the ordinary drain. The clean repair is deletion: after the
existing structural fast-out and live-token entanglement loop, fixup always
folds the current committed-for-root world and compares it with the rendered
value. This withdraws the zero-`w_fx` in-transition-mount claim and charges the
work to the existing mount gate; it removes state and a branch from F3.

R2's pass-aware delivery, R3's lineage seeding and pre-commit restart, R4's
durable drains, R8's discard-before-live-renumber, and R9's per-world atom
identity survive adversarial re-derivation below. The fork remains nine
versioned facts, tests 1–33 remain the merged suite, and the two new attacks
are pinned as integration tests rather than new seam facts. DIRECT mode is
unchanged and executes zero concurrency instructions. The repaired design has
no unwalked docket case and no new correctness gap.

---

## Terms used in this amendment

- **Global sequence (`seq`)**: the monotone integer line shared by writes,
  retirements, evaluator promotions, render pins, and committed-advance
  stamps. Comparisons across these events are meaningful because they use one
  line.
- **Batch token / slot / mask**: React gives each live batch a stable integer
  token. The library interns at most 31 live-or-unswept tokens into slots; a
  pass mask names the batches it renders.
- **World**: an immutable view header containing a root, pass mask, pin, and
  immutable per-root lock view. A receipt is visible when its retirement is at
  or below the pin, its live slot is in the pass mask and its write is at or
  below the pin, or its slot is in the root's lock view and its write is at or
  below that slot's watermark.
- **K0 / K1**: K0 is the canonical newest-world signal graph. K1 is the union
  of real dependency edges recorded by non-newest evaluations. K1 does not
  alter K0's hot traversal records.
- **Canonical-trust (`CT`)**: the inherited freshness predicate that says a
  K0 value can be served without recomputation. It is necessary but, for a
  pass world, not sufficient.
- **Touched word**: the inherited per-node slot/taint reach word. It routes
  receipt-sensitive reads and feeds durable per-slot touched lists. It is not
  the value-blind notification walk.
- **Evaluator**: a `useComputed` function or reducer whose identity can change
  with hook deps. A staged evaluator belongs to a render lineage until F9
  publishes it. A committed evaluator version is
  `{fn, deps, stamp, promotedAtSeq}`.
- **Effective evaluator**: for a pass world, the pass's staged version when
  present, otherwise the committed version with greatest
  `promotedAtSeq <= world.pin`; for NEWEST and committed-for-root reads, the
  latest committed version.
- **Evaluator basis**: the exact flattened vector of `(evaluator, stamp)`
  pairs consumed to produce a cached value. Each stageable evaluation records
  its own pair before invoking user code and merges child vectors. The vector
  already exists for memo validity and suspense content validity.
- **World memo**: the per-`(node, worldKey)` cached value and its validity
  basis. Atom folds use this same plane, so one atom has one reference in one
  world.
- **Watcher**: a mounted component subscription. Its notification is a
  synchronous `setState` in the writer's context.
- **Fixup (`w_fx`)**: the layout-time render-to-subscribe check. It first
  entangles live batches that the mount may have missed, then compares the
  rendered value with the current committed-for-root value and schedules an
  urgent pre-paint correction if they differ.
- **Lineage**: the fork identity stable across retries/replays of one root and
  batch selection. Its stage cache lets a retry see staged evaluators before
  tree-order-late owner hooks run.

---

## Normative replacement S5-R1 — evaluator versions participate in routing

This extends round-4 R1; its pin-gated version chain, retention rule,
promotion ordering P1′–P4, value-blind promotion walk, RENDER_NEWEST
demotion, and memo/capsule validity checks remain unchanged.

For the current K0 cached value of node `n`, let `B0(n)` be its existing
flattened evaluator basis. Define the following predicate as math, not a new
stored flag:

```text
EB0(n, w) := for every (e, stamp) in B0(n),
             effectiveStamp(e, w) == stamp
```

Let `B_r(n, w_r)` be the basis of the exact cached result the render served:
`B0(n)` when it served K0, otherwise the basis of `M(n, w_r)`. Define:

```text
EBr→c(n, w_r, w_c) := for every (e, stamp) in B_r(n, w_r),
                      effectiveStamp(e, w_c) == stamp
```

Both are exact vector walks; there is no lossy hash and no allocation. The
normative routing changes are:

1. A pass-world read may serve K0 only if all inherited K0 gates hold **and
   `EB0(n, world)` holds**. Test this before returning K0, not after entering
   the world-memo ladder. A mismatch routes to the existing world evaluation.
2. The staged-only routing probe is replaced by this effective-version probe.
   A stage, a pin-resolved superseded committed version, and a nested
   evaluator therefore use one rule.
3. The mount fixup's initial structural fast-out may return only if its
   inherited conditions hold **and `EBr→c(n, w_r, committedForRoot(now))`
   holds**. The pass retains the cache/basis it served through layout under
   the inherited pass-owned memo lifetime; this adds no watcher field. A
   version change in the render-to-subscribe window must reach the final
   `w_fx` compare.
4. Every world memo still checks its own flattened evaluator basis before
   clocks or value serve. Promotion still dirties K0, demotes open
   RENDER_NEWEST passes, and performs the unconditional value-blind walk.

No new completeness obligation is introduced: evaluator-basis flattening is
already required by I31/I40 and round-4 R1 for memo and suspense validity.
This amendment merely consults that same exact basis one decision earlier.

### S5-R1-A pinned attack: recomputed K0 leaks a post-pin evaluator

Setup: shared stageable reducer atom `ra`; committed reducer `r0` maps
`inc` to `+1`, staged reducer `r1` maps it to `+10`; receipt X contains
`inc`. Root B renders siblings B1 and B2 from X-world. Root A owns the hook
that can publish `r1`.

```text
step | actor/mechanism | state touched (values, bases, lanes)
1 | root-B pass P starts | pin=q; mask={X}; effective reducer=r0
2 | B1 reads ra | fold under r0 => 1; B1 renders 1; P yields
3 | root A F9 publishes r1 | promotedAt=sA>q; K0 dirtied; open P demoted; value-blind walk schedules B; no equality gate
4 | NEWEST read on A | K0 recomputes ra under r1 => 10; K0 becomes CT with B0(ra)={(ra,r1)}
5 | P resumes and B2 reads ra | EB0 compares effectiveStamp(ra,P)=r0 with cached r1 => mismatch; route existing world memo; fold X under r0 => 1
6 | P commits | B1=1 and B2=1; queued publication delivery later renders both under r1 => 10
outcome: the old pass cannot serve the recomputed K0 value; every committed frame uses one reducer version.
residual risk: omitting the probe at any K0-return site reopens the leak; integration test S5-R1-A instruments every K0 serve and forces step 4.
```

Without rule 1, step 5 returns 10 because `touched==0` and K0 is clean; the
version-aware memo ladder is never entered. That is the judge's R1 blocker.

### R1 construction

Base case: with no staged or superseded evaluator, every recorded basis pair
resolves to the sole committed stamp. `EB0` holds, so the inherited K0 gates
decide exactly as before.

Inductive step for a stage: staging changes `effectiveStamp` in that pass.
The node records its own evaluator pair before user code, and every parent
that consumes it merges the pair; therefore the first cached node whose value
could depend on the stage has a mismatching pair and routes. R3 restarts any
watcher that rendered before the stage was minted.

Inductive step for a promotion: consider the two possible K0 bases. If K0 is
still based on the old version, a pre-promotion pass matches and is safe;
NEWEST/latest worlds mismatch or see P2′ dirtiness and recompute. If K0 has
been recomputed under the new version, latest worlds match and every pass
pinned before promotion mismatches and world-routes. Flattening applies the
same argument transitively to a parent cache. Thus replacing either K0 basis
cannot make an incompatible world satisfy the exact predicate.

Equal output does not weaken the argument: evaluator stamp identity, not
value equality, controls routing, and promotion delivery remains value-blind.

---

## Normative replacement S5-R12 — delete the commit-baseline fast-out

Round-4 R12 is deleted in full. Delete:

- `commitBaseline = {cas, lockViewId}` from every root registry;
- its F3 pre-layout capture;
- `cas == baseline.cas && lockViewId == baseline.lockViewId => return` from
  fixup;
- its lifecycle and live-renumber rows; and
- the claim that an in-transition mount reaching committed-side fixup does
  zero `w_fx` evaluations.

The rest of fixup is unchanged, with S5-R1's added evaluator conjunct:

1. The inherited structural fast-out remains
   `touched(n)==0 && CT(n) && !w_r.fastPathDisabled && EBr→c(...)`.
2. The R6 live-token loop uses the per-clause visibility bound and calls
   `runInBatch` for every missed live token.
3. If execution reaches committed-side fixup, it **always** obtains the
   memoized value for `committedForRoot(root(W), now)` and compares it with
   the rendered reference/value under the node's equality policy.
4. A difference schedules the inherited urgent pre-paint correction. Equality
   records the current basis and returns without an update.

### S5-R12-A pinned attack: retirement between render and baseline capture

Setup: transition K mounts watcher W over `c=a`; pass P excludes default batch
D. W does not exist before P, so no earlier notification can target it.

```text
step | actor/mechanism | state touched (values, marks, drains)
1 | P renders fresh W | pin=p; a=0 and c=0; W is not subscribed yet; P yields
2 | gap: D writes a=1 at sD>p | receipt logged; K0/newest becomes 1; write walk reaches c but no mounted W exists
3 | D retires before P commits | retiredSeq=sR>p; D drain runs, but W is still absent; committed-for-root now includes a=1
4 | P commits K | lock-in/folds/drains run before layout; old R12 captures baseline after D retirement and after this lock-in
5 | W layout fixup | touched(c) is nonzero, so the first fast-out fails; D is retired, so the live-token loop has no D corrective
6a | deleted behavior | old comparator sees current cas/lockViewId equal the just-captured baseline and returns, leaving DOM c=0 beside committed c=1 forever absent unrelated work
6b | repaired behavior | no baseline branch exists; w_fx folds committed-for-root => 1; 1 != rendered 0; urgent pre-paint setState renders W=1
outcome: every visibility change in the render-to-subscribe window is compared after subscription; the stale frame never paints.
residual risk: reintroducing any “capture now, compare now” currency shortcut recreates the same tautology; integration test S5-R12-A holds P across D's full retirement.
```

### R12 construction

Base case: if committed-for-root did not move after render, `w_fx` returns the
same memoized reference/value, so fixup schedules nothing.

Step for a receipt/lock visibility change before subscription: a relevant
unswept change carries its slot through `touched`, a saturation sweep sets
`fastPathDisabled`, and a relevant live token is examined by the R6 loop. The
structural fast-out therefore cannot hide a relevant receipt change; the
final fold observes current committed truth.

Step for an evaluator promotion before subscription: S5-R1 makes the rendered
evaluator basis fail `EBr→c`, so the structural fast-out cannot hide it; the
final fold resolves the latest committed evaluator. After subscription,
ordinary value-blind walks and R4 drains own later changes. Those three cases
partition the render-to-subscribe timeline.

The cost is explicit and unmeasured: every mount that reaches step 3 performs
one committed-for-root memo lookup and, on invalid basis, one fold/evaluation.
The 10k-mount transition and cross-root mount-storm rows remain in W2, but the
expected result is now the P1 mount gate (within 15% of the equivalent React
mount), not “zero `w_fx` evaluations.” Gate failure rejects this final design;
no replacement mechanism is pre-authorized.

---

## Round-5 docket: independent adversarial re-derivation

### R1 — REPAIRED AND HELD

S5-R1-A is the killing schedule and repair walk. Two adjacent probes also
hold:

```text
step | actor/mechanism | state touched (mount interaction)
1 | old root-B pass P mounts W | pin=q; world memo records evaluator basis r0; W not subscribed
2 | root A publishes r1 and recomputes K0 | promotedAt>q; P remains pinned; publication walk cannot target unmounted W
3 | P commits and enters layout fixup | EBr→c resolves rendered r0 against committed r1 => false; structural fast-out forbidden
4 | S5-R12 fixup | no commit-baseline branch; w_fx under r1 differs; urgent pre-paint correction
outcome: the R1 router and R12 deletion close both the read path and the late-subscription path for the same version race.
residual risk: the test must mount after P's first read and publish before layout; a pre-existing watcher would not exercise this seam.
```

### R2 — VERIFIED HELD: pass-aware same-slot suppression

“Pass includes slot s” means `s` is in the pass's render mask, not merely in
its root lock view. A started pass stays registered through completion until
commit/discard. A set `(W,s)` bit suppresses a new write at `seq` only when no
started-uncommitted pass on `root(W)` has both `s in pass.mask` and
`pass.pin < seq`.

```text
step | actor/mechanism | state touched (bits, pass, lanes)
1 | T writes a=1 at s1 | value-blind walk calls setState(W) in T; bit(W,T)=1
2 | T pass P starts at pin p>=s1 and yields/completes before W consumes the new post-pin write | registry retains {mask:{T}, pin:p, uncommitted}
3 | T continuation writes a=2 at s2>p | walk reaches W; bit is set, but P includes T below s2 => do not suppress; enqueue interleaved T update
4 | P resumes/attempts commit | it may render/commit the p-world, but the interleaved update remains pending; fork test 14/32 forces restart before commit when insertion timing permits
5 | follow-up T pass | fresh pin>=s2; W renders 2 before any watermark can advance through s2 without W's lane
outcome: no watermark exposes s2 beside W's s1 DOM; completed-uncommitted and yielded passes take the same branch.
residual risk: F2 must retain completed-uncommitted pass metadata and test 32 must pin insertion after completed work.
```

No-pass writes may suppress: the already scheduled T work has not started and
will capture a pin at or above the new write. A pass that sees T only through
an older lock watermark does not consume the pending T-lane update, so it is
not a counterexample; the original scheduled T work remains and over-delivery
is not needed. Different slots use different bits (C4).

### R3 — VERIFIED HELD: lineage seeding, walk, and A/B/A

Stable A→B:

```text
step | actor/mechanism | state touched (stage cache, watchers, restart)
1 | pass P starts; lineage cache empty | passStages=A(committed); earlier sibling S renders A; lastRenderPassId(S)=P
2 | owner O selects B | mint lineage-stable B stamp; cache:=B; stage-set change walks K0∪K1; S qualifies and receives queued own-lane update
3 | yield/end drain | update enters React before commit; P restarts
4 | retry P' starts | seed B before S renders; S renders B; O selects/reuses B; no stage-set change
5 | P' commits | F9 publishes B only now; no tentative publication existed
outcome: no commit contains an A consumer and B owner.
residual risk: edge completeness and pre-commit restart are pinned by integration staging-order test plus fork tests 14/32.
```

Adversarial A/B/A:

```text
step | actor/mechanism | state touched (seed transitions)
1 | attempt P0 seeds A | S renders A; O selects B; cache A→B; walk queues restart
2 | attempt P1 seeds B | S renders B; O now selects committed A; hook authority removes B from cache; contradiction B→A walks and queues restart
3 | attempt P2 seeds A | S renders A; O selects A; no change and no walk
4 | P2 commits | F9 has no B publication; committed evaluator remains A
outcome: two finite changes cause two pre-commit restarts, then a uniform A commit.
residual risk: user render code that changes deps on every attempt can continue oscillating; React's existing render/update-depth rejection is the specified termination, not a signals-side loop.
```

Coverage induction: before a stage-set change, every earlier consumer either
is the staged node's watcher or consumed it through K0/K1 edges recorded before
the change; the full walk reaches both. Adding an edge can only add a route,
and walk generation stamps terminate K1-union cycles. Consumers after the
change read `passStages` directly. A restart seeds the latest selection, so a
stable hook selection performs no second walk.

### R4 — VERIFIED HELD: every committed visibility flip drains watchers

```text
step | actor/mechanism | state touched (late edge and drain)
1 | parked K writes flag=true | K0 path flag→c→W; touchedList[K] contains c/W; W scheduled in K
2 | K pass P pins p and yields | P world fixed
3 | store-only D writes a=1 and retires | canonical graph has no a→c edge; D drain is quiet; D remains unswept because P's pin excludes it
4 | P resumes under c=flag?a:b | P sees K's flag but excludes retired-after-pin D, so c=0; K1 records a→c; edge-add propagates D's retained bit
5 | P commits and advances K to p | committed-for-root now sees K flag=true plus retired D a=1; advance drain enumerates touchedList[K], reconciles W, sees rendered 0 vs committed 1
6 | urgent pre-paint correction | W renders 1 before paint
outcome: the lock advance that first makes the combined value committed also performs its watcher correction; global K retirement need not occur.
residual risk: clearing bits before the final possible flip breaks the induction; unswept retention and fully-retired-only force-clear tests pin it.
```

Coverage base: if a flipping token's receipt path existed at write time, its
mark walk placed every reached node on that token's durable list. Coverage
step: when a missing path edge is later inserted, the endpoint's retained
token bits propagate through the new edge and append newly reached nodes.
Only a token with no future flip may lose those bits: its entries are compacted
and all root lock records are gone. Therefore retirement, lock-in, and every
watermark advance enumerate every watcher whose committed value can change.
Late subscriptions after a drain are handled by S5-R12 rather than extending
the drain mechanism.

### R8 — VERIFIED HELD: discard WIP before live renumber

The order-preserving rewrite duty list includes tape `seq`/`retiredSeq`, atom
`baseSeq`, slot write clocks, every lock-view watermark, committed-advance
sequence, visibility stamps, evaluator `promotedAtSeq`, memo and capsule
sequence/fingerprint fields, effect and watcher snapshot pins, lineage-cache
stamps, and all other fields declared on the inherited §15 sequence ledger.
Token serials and generation counters are separate domains.

```text
step | actor/mechanism | state touched (wrap and external identity)
1 | pass P is live at pin 6; WIP hook holds F9 stage id 7 | next globalSeq mint would cross forced horizon H=7
2 | operation-boundary horizon check | fork discards every WIP pass; P's pin and WIP F9 attachment die; no seq identity remains outside library-owned records
3 | library rewrite | map retained ordered seqs monotonically into compact range; rewrite every ledger field, including lock watermarks and promotedAtSeq
4 | epoch bump | every old worldKey/memo/capsule key fails; counters restart above rewritten maximum
5 | React retries discarded work | new pass receives a new pin and lineage attachment in the rewritten epoch
6 | later retirement | rewritten retiredSeq and pin preserve their original order; neither false visibility nor stale F9 CAS is possible
outcome: the live-pin wrap horn and externally held WIP-stage-id horn are both removed before comparison values change.
residual risk: an omitted seq-bearing field is fatal; forced-small-horizon tests populate every ledger row before step 2 and schema CI asserts rewrite coverage.
```

Ordering construction: the rewrite is strictly monotone on the finite retained
set, so `<`, `<=`, and equality relationships are preserved. Discarding WIP is
the base condition that makes the retained set library-closed. Epoch bumping
then prevents an unrewritten cached key from validating accidentally.

### R9 — VERIFIED HELD: one fold, one reference per atom/world

```text
step | actor/mechanism | state touched (fold memo and reference)
1 | T logs updater x => ({v:x.v+1}) | receipt stores the op; no render fold yet
2 | pass P first reads atom a in world w | replay once; result reference R stored in M(a,w) with prefix/fingerprint
3 | P reads a again, including through a sibling computed | same valid M(a,w) returns R; updater is not reinvoked
4 | P commits T at watermark equal to P.pin | committing visible prefix equals M(a,w)'s prefix; install R as committed reference before compacting
5 | layout/effect/reconcile reads | committed memo returns R; no reference-only corrective ping-pong
outcome: `a.state === a.state` within w and committed state owns the exact reference rendered by the committing pass.
residual risk: any retirement path that replays an already memoized committing prefix instead of installing it is pinned by the object-reference differential test.
```

A different world may replay the updater and obtain a different reference;
that is React's own rebase behavior. Stepwise custom equality keeps the prior
accumulator reference on equal. A store-only retirement with no committing
memo folds exactly once and installs that fresh result. Evaluator-basis checks
from S5-R1 occur before serving a reducer fold memo, so R1 does not weaken R9.

### R12 — REPAIRED AND HELD

S5-R12-A is the killing schedule and repair walk. The deletion also makes the
R4 late-subscription boundary simple: drains own already-mounted watchers;
`w_fx` owns every mount that missed a drain. No captured-current shortcut sits
between them.

---

## Acceptance-battery impact closure

This round does not reopen or rederive math outside its docket. The round-4
full C1–C17 walks remain normative. The only changed intersections are:

| inherited case | round-5 effect |
|---|---|
| C1/C1-X1, C3-R/C3-M, C15 | S5-R1 makes the already-required exact evaluator vector a pre-K0 routing gate; pin arithmetic, publication, and suspense identity are unchanged. |
| C2, C3, C8 | no write visibility, replay, or equality rule changed. |
| C4/C5 | R2 rewalk above; delivery remains a separate full value-blind walk. |
| C6/C7 | no grouping or pass/yield classification changed. |
| C9/C10 | S5-R12 replaces the unsound baseline return with the existing final committed compare; S5-R1 supplies evaluator-window routing. |
| C11 | pin-scoped evaluator versions and R4 cross-root drains are rewalked; full-spanning scope remains. |
| C12 | parking/carrier and fold-on-retire are untouched. |
| C13 | `commitBaseline` is removed from the lifecycle table; R8 has one fewer field to rewrite. |
| C14 | R3 A/B/A/replay and F9 publication timing are rewalked; no tentative publication is added. |
| C16 | effects still read committed-for-root snapshots and every visibility flip drains them. |
| C17 | truncation remains absent from the API. |

Unwalked docket cases: none. No inherited acceptance case loses its walk.

---

## Mechanism inventory — 9

1. **K0 donor kernel and twin builds** — packed monomorphic newest-world
   graph; DIRECT build contains no concurrency instructions.
2. **Receipt tapes and React-parity folds** — every React-mode write logged;
   replay in global write order with stepwise equality.
3. **Tokens, slots, masks, pins, and immutable lock views** — per-root
   watermarked committed visibility; unswept retention and saturation.
4. **K1, touched words, and the two walks** — real world edges; monotone mark
   propagation plus a separate full value-blind notification walk.
5. **World memos and suspense capsules** — closed validity bases, including
   atom fold identity and exact thenable settlement identity.
6. **Evaluator staging, version chains, F9, and promotion** — S5-R1 changes
   only where the existing flattened basis is consulted.
7. **Watcher/binding records and fixup** — pass-aware delivery, live-token
   entanglement, durable-drain reconcile; S5-R12 deletes commitBaseline.
8. **Fork/build protocol F1–F9 and continuation carrier** — unchanged fact
   count; F3 does less work after the deletion.
9. **Episode lifecycle** — epoch/generation resets, discard-before-renumber,
   pass-owned reclamation, and bounded inherited K1 sweep.

State delta: `+0`; `-commitBaseline.cas`, `-commitBaseline.lockViewId` per
root. Mechanism count remains 9.

---

## Fork protocol — 9 seam touch-points

The boundary passes only integers, booleans, immutable integer collections,
and callbacks; no Fiber, lane bitmask, or update-queue object crosses it.

1. **F1 — write classification and token claim.** At a signal write, report
   whether it is deferred and its lazily minted stable batch token. Tokens are
   never reused while live or unswept.
2. **F2 — pass lifecycle and callstack truth.** Report
   start(rootId, included tokens, pin, lineage), yield, resume, completion,
   commit, and discard. A handler in a yield gap has no render frame. F2 also
   supplies the inherited discard-all-WIP control used at the R8 horizon.
3. **F3 — per-root commit lock-in.** Report the generation-checked rootId,
   committed token set, and each committing watermark. Ordering is F9
   publication, folds/lock-view remint, durable watcher/effect drains, then
   layout. S5-R12 removes only the library's commitBaseline capture.
4. **F4 — retirement.** Exactly once per token, report committed flag and a
   retirement point on the global sequence line. `committed=false` still
   folds writes. Async actions park this edge until settlement.
5. **F5 — lane-scoped execution.** `runInBatch(token, callback)` inserts the
   callback's React update into that live token's lanes; a retired token returns
   `RETIRED`, allowing urgent fallback.
6. **F6 — render lineage.** Mint an identity per root and batch selection,
   stable across its retries/replays and dead at commit/abandon.
7. **F7 — DOM mutation window.** Edge-triggered begin/end facts delimit the
   mutation interval for integration policy; no sampled reconciler state.
8. **F8 — async-action parking and continuation carrier.** Preserve token
   identity across transformed/platform-supported continuations and registered
   host callbacks; a continuation that outlives retirement degrades to ambient
   classification with a dev warning.
9. **F9 — hook-becomes-current publication.** Emit the generation-checked
   staged evaluator identity only for the hook version that becomes current,
   including hidden Offscreen commits; emit nothing for discarded/error-
   abandoned alternates; order publication before same-commit folds.

Version skew is loud: bindings feature-detect the exact protocol version and
reject stock or incompatible React. With no listener, each reconciler site is
one null check. Rebase drill: if React renames lanes, moves phases, or rewrites
queues, only the fork adapters that re-establish F1–F9 and their tests move;
the signals library changes zero lines.

### Merged fork-test list — all VERIFIED HELD

The list below is the normative merged semantic suite. Tests 29–33 retain the
round-4 merged numbering.

| test | required observable assertion | fact |
|---:|---|---|
| 1 | A write outside a transition is classified urgent/default as React classifies the surrounding update. | F1 |
| 2 | A transition write is deferred and receives the transition's token. | F1 |
| 3 | One batch's token is stable across nested calls and action continuations. | F1/F8 |
| 4 | A live or retired-unswept token is never reused; forced-small serials fail loudly rather than collide. | F1/F4 |
| 5 | passStart reports exact rootId, included-token set, pin, and lineage before user render code. | F2/F6 |
| 6 | yield removes render context from the JS callstack; resume restores the same immutable pass frame. | F2 |
| 7 | A handler in a yield gap reads/writes ambient newest state and gets its own batch. | F1/F2 |
| 8 | Each pass has exactly one terminal completion/commit/discard path; a restart is a new pass. | F2 |
| 9 | Retirement fires exactly once for committed and committed-false tokens. | F4 |
| 10 | A store-only token with no Fiber work still retires and persists its writes. | F4 |
| 11 | An async action cannot retire before its returned action settles. | F4/F8 |
| 12 | `runInBatch(t)` schedules into t's existing lanes, not a fresh transition. | F5 |
| 13 | `runInBatch` on a retired token returns `RETIRED`; urgent fallback executes before paint. | F5 |
| 14 | An own-lane update inserted at yield/end into an in-progress pass causes React's native pre-commit interleaved restart. | F2/F5 |
| 15 | First commit of a spanning token locks only that root and reports its root generation. | F3 |
| 16 | A later same-root commit advances the immutable lock view by the reported prefix, not whole-token membership. | F3 |
| 17 | Two roots may commit at different times; global retirement remains exactly once after React is done with the token. | F3/F4 |
| 18 | A lineage id survives Suspense retry and StrictMode replay for the same root/batch selection. | F6 |
| 19 | Commit/abandon kills the lineage; a later selection cannot reuse it while caches survive. | F6 |
| 20 | A hidden Offscreen hook that becomes current emits F9 even when effects do not run. | F9 |
| 21 | Error-abandoned, discarded, and stale-alternate hooks emit no publication. | F2/F9 |
| 22 | F9 publication is generation-checked and emitted once for the winning hook version. | F9 |
| 23 | F9 publication precedes same-commit reducer folds, lock-in drains, and layout. | F3/F9 |
| 24 | DOM mutation begin/end events bracket the real mutation interval exactly once per commit. | F7 |
| 25 | Missing or incompatible protocol version fails loudly before bridge activation. | all |
| 26 | With no bridge listener, every hook site performs only its single inert null check. | all |
| 27 | Carrier identity survives await, Promise.all, transformed async generators, and shimmed timer/microtask/rAF registration without cross-action bleed. | F8 |
| 28 | A fire-and-forget continuation invoked after token retirement uses ambient classification and warns; it neither resurrects nor parks the token. | F8 |
| 29 | A discarded pass cannot later commit or emit lock/publication facts. | F2/F3/F9 |
| 30 | A same-root urgent commit discards an older yielded pass before that pass can publish F9 or lock tokens. | F2/F3/F9 |
| 31 | Root ids are stable and generation-checked; a portal reports its parent root, not a new root. | F2/F3 |
| 32 | An update inserted after render work completed but before commit forces a pre-commit restart. | F2/F5 |
| 33 | Every reported lock watermark equals the committing pass's pin. | F2/F3 |

S5-R1-A and S5-R12-A are signal/fork integration tests, not additions to the
seam: they compose existing facts and therefore leave the fork-test count and
touch-point count unchanged.

---

## Cost and gate amendments

- **R1 routing**: no allocation and no new stored word. On a React pass-world
  K0-return candidate, the existing evaluator-basis probe now resolves
  pin-gated committed versions as well as pass stages. Empty bases are one
  length check; nonempty cost is linear in the already-flattened evaluator
  prefix. Exact overhead is unmeasured. Charge it to G-Q/SPK-G8 and retain the
  P1 ≤1.10× render and P3 quiet-React gate; do not assert a percentage before
  measurement.
- **R12 deletion**: removes two integers/root, one F3 capture, one compare,
  its renumber row, and its lifecycle row. It adds a committed-for-root memo
  lookup/fold to each fixup that survives the structural fast-out. Charge the
  10k in-transition mount and cross-root mount-storm rows to W2 and the P1
  mount ≤1.15× gate. No fallback is authorized in this final round.
- **R2/R3/R4/R8/R9**: no implementation delta. Their existing SPK-W,
  SPK-N1, SPK-R, and horizon tests remain. This artifact makes no new numeric
  claim.
- **DIRECT**: unchanged twin build; zero concurrency instructions.
- **Steady rerender allocation**: unchanged; both repairs allocate zero.

Known non-correctness gaps inherited unchanged: G9's bounded-but-not-proven-
flat K1 growth under never-quiescent traffic and the queued performance spikes
listed by the champion. They are outside the round-5 repair scope and are not
hidden as correctness TODOs.

---

## Final audit ledger

| docket item | verdict | normative delta | pinned schedule |
|---|---|---|---|
| R1 pin-resolved evaluator chain | blocker repaired; held | exact flattened evaluator basis gates K0 serve and fixup fast-out | S5-R1-A + mount interaction |
| R2 pass-aware suppression | verified held | none; “includes” means pass mask | yield-gap same-slot post-pin write |
| R3 seed/walk/termination | verified held | none | earlier consumer A→B; A/B/A |
| R4 closed drain coverage | verified held | none | retired late-edge + lock advance |
| R8 live renumber | verified held | delete commitBaseline from duty list only | live pin + WIP F9 id at forced horizon |
| R9 reference installation | verified held | none | functional object updater, repeated read, committing install |
| R12 baseline comparator | blocker repaired; held | optimization and state deleted | retirement between mount render and layout |
| fork tests 1–33 | verified held | F3 is smaller; no fact added | merged list above |

Mechanisms: **9**. Seam touch-points: **9**. Unwalked cases: **none**.
