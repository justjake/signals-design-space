# Round 3 breaker design — two-kernel champion, adversarially armored

Status: complete design artifact. Stance: **breaker**. This keeps the round-2
two-kernel architecture, repairs three confirmed correctness/liveness breaks,
repairs one invalid performance denominator, and records the one boundary no
ambient carrier can make safe. No legacy design, other author artifact, or
other round artifact was consulted.

## 1. One-page concurrency story

There are two generated builds of one signal engine. **DIRECT** is the measured
arena donor: a closed, monomorphic push-pull graph, called **K0**, with no
concurrency instructions. Registering the React bridge monotonically selects
**LOGGED**. In LOGGED every write, urgent writes included, appends an ordered
receipt before updating K0's newest value. A render reads a **world**: a frozen
root, set of included React batch tokens, sequence pin, and per-root lock-in
snapshot. Atom values are reconstructed by replaying visible receipts in write
order, applying custom equality after every operation. This is React's queue
arithmetic, including skipped-update rebasing.

Pending worlds evaluate computeds in a separate, add-only dependency graph,
**K1**. K1 records the real edges seen in those worlds without adding world
branches to K0's hot walks. A 31-bit `touchedSlots` column says which live batch
receipts can reach each node through K0 or K1. Reads use K0 only when the asked
world is newest, or when the node is already K0-clean and has no touched bit;
otherwise they use a memo for the frozen world. A newly recorded edge propagates
old touched bits through existing out-edges and retroactively schedules every
reached watcher into each still-live token's lanes. Queued retro-deliveries
carry token serials, slot generations, and watcher generations, and are drained
on every render-slice exit before host code or commit can run.

Per-atom tapes are the value truth. Cached values are only accelerators, and a
closed change-source table invalidates them for writes, retirement, root
lock-in, evaluator change, settlement, world change, episode change, and node
reuse. This round replaces the root-global part of `visStamp` with a
**root-slot lock stamp captured in the pass's immutable lock view**. Retirement
still has a per-atom visibility stamp. Every visibility event mints from the
same monotone sequence line, so an older receipt becoming visible beneath a
newer one still changes the fingerprint, while root A can no longer invalidate
an unchanged suspense resource on root B forever.

Hook evaluators are committed state, not render-global mutable state. Each pass
stages its own function, deps, reducer, and stamp. The fork attaches an opaque
publication id to the exact work-in-progress hook and publishes it when that
hook's fiber becomes current, including a hidden Offscreen commit and excluding
an error-boundary-abandoned subtree. Publication happens before layout effects;
it does not depend on an effect firing. A generation-checked compare-and-swap
prevents an old alternate from publishing over a newer hook.

Watcher notification remains value-blind: a full K0-union-K1 reach walk on
every write, followed by `setState` in the writer's token. There is no implicit
grouping and no equality cutoff that could miss finished-but-uncommitted work.
Mount fixup schedules into every live written token whose touched bit reaches
the node, then compares against the root's committed world for the retirement
race. React signal effects read only committed-for-root worlds; core effects
read newest and can be configured to flush synchronously for benchmarks.

Async actions park their token and restore it around every transformed
continuation. Native `AsyncContext` is preferred when present; otherwise a
measured twin-build transform selects a native fast body when unarmed and a
token-carrying driver while armed. Nested actions under a carrier share the
token with a park refcount; independent actions retain distinct tokens.
Uncompiled promises may be awaited safely when only the transformed caller
writes afterward. An uncompiled function that itself writes after its own
`await` is not ambiently solvable; it must be transformed or use the explicit
token-bound `ActionScope.set/dispatch` surface. Action tokens and atoms are
realm-affine; workers return data and owner-realm code performs the write.

Per-root lock-in is a prefix, never token membership. Only a commit whose exact
include set contains token `t` may advance `t`'s watermark, and it advances by
`max(old, committedPass.pin)`. An unrelated urgent commit cannot expose a
post-`await` action write. A pass's lock view is immutable; the fork ends older
same-root passes before a lock view advances. Retirement makes receipts globally
visible, preserves pins, folds only all-retired prefixes, and never drops writes.

At quiescence K0 must regain a notification basis before K1 resets. Every
K1-touched committed watcher/effect dependency is pulled in K0 at newest. If a
legal writing computed prevents this twice, the observed target becomes exempt
and the **entire reverse-reachable K1 dependency cone**, not merely its direct
in-edges, is copied into the fresh K1 plane. A two-strike rank proves termination
for a fixed observed graph; unbounded user-created work is rejected by the
ordinary signal-loop budget. All counters have an epoch, generation, clear, or
hard pre-overflow stop.

The design has **10 cooperating mechanisms** and **9 versioned seam facts**.
DIRECT retains the donor's measured numbers. Every LOGGED number below is a CI
gate or an explicitly unmeasured spike; no projected cost is stated as fact.

## 2. Breaker findings

### 2.1 Confirmed breaks, all armored

| id | killing schedule | why round 2 fails | armor here |
|---|---|---|---|
| B1 — cross-root `visStamp` starvation | Park async token T. Root A repeatedly commits longer T prefixes to atom `a`; root B has a suspended lineage reading `a` but neither includes nor locks T. A's every lock advance mints the one global `visStamp(a)`, so B drops and recreates its resource although B's fold never changes. Keep T parked and repeat: B never settles. | Touched-atom scope is not enough; lock-in is also root-scoped. The old max changes for an irrelevant root. | Retirement uses `retireVisStamp[a]`; lock-in uses `(root, slot)` stamps stored in immutable lock views and included in `fp(a,w)` only when that world locks an entry of `a` from the slot. A cannot move B's fingerprint. |
| B2 — hidden Offscreen publication | Committed evaluator is `f0`. A transition renders hidden Offscreen content with `f1`; React commits that hidden fiber but does not run its ordinary hook layout/passive effect. Later the tree reveals by reusing committed hidden work. DOM/output is from `f1`, while NEWEST, fixup, or an effect still calls `f0`. | "Promote at the hook's commit effect" confuses effect execution with fiber publication. Hidden commits and effect disconnection are legal. | New seam fact F9 attaches an opaque publication id to the WIP hook and emits it when that exact hook becomes current, hidden or visible, before layout effects. Error-abandoned hooks emit nothing; generation CAS rejects stale alternates. |
| B3 — non-transitive refresh carry | In episode E1 K1 alone contains `x -> u -> w`; `w` is watched. Refreshing `w` performs a legal write twice, so it becomes exempt. Carry only "w's K1 in-edges" (`u -> w`), reset K1, then in E2 write `x`. `x -> u` is gone; W is not scheduled and a T commit can tear. | Reach is path-transitive; preserving one edge does not preserve the induction basis. | Exemption copies the complete reverse-reachable K1 cone of each exempt observed target, retaining both links of every K1 edge. A successful ordinary K0 pull clears the exemption later. |
| B4 — W5's zero denominator | A store-only transition writes 10k atoms and has no React render; 5k committed effects are affected. The old gate says retirement must cost at most 2x "the batch's own render", namely zero. Any correct fold fails. | The comparator omits mandatory pure-core effect work. | G-R now compares retirement engine overhead and user evaluations separately against DIRECT `batch()` on the identical graph; React reconciliation has its own useState comparator. |

### 2.2 Boundary that cannot be ambiently armored

**U1 — arbitrary uncompiled post-await writer.** Killing schedule: transformed
action A calls uncompiled `thirdParty(atom)`; that function awaits internally
and then calls raw `atom.set(2)`. Meanwhile an unrelated click is legal. When
the third-party continuation runs, there is no carrier. At `set`, its observable
runtime state is the same as an unrelated carrierless promise/timer write while
A is parked. Assigning it to A misclassifies the unrelated write; assigning a
default token commits `2` before A settles. Patching `Promise.then` cannot see
native `await`.

This is a support boundary, not a hidden fallback. A package that performs raw
post-await signal writes must be transformed, use native `AsyncContext`, or
receive an `ActionScope` and call `scope.set/dispatch`. Merely returning a
promise to transformed code is legal. The build manifest and boot probe prove
that the application transform is installed; they cannot prove semantic facts
about opaque code receiving an Atom dynamically. The support matrix says so.

### 2.3 Verified-held attacks

| attack | vicious schedule | reason it holds / permanent test |
|---|---|---|
| visStamp injectivity, same root | Newer visible `set(3)` hides older pending `+1`; retirement or a watermark advance reveals `+1` below it without changing newest visible seq. Interleave two roots, three tokens, and out-of-order retirements. | The event's retirement stamp or captured root-slot lock stamp is newly minted above every old term. Clear-on-retire first mints the retirement stamp, so losing the lock term cannot restore an old max. Differentially enumerate event orders. |
| error boundary staging | One pass stages child `f1`, throws, and commits fallback while a sibling stage commits. | F9 publishes only hook ids on fibers made current. The child id receives no event and is swept after commit; the sibling CAS promotes. |
| reused/alternate fibers | T stages `fT`; U stages/commits `fU`; a stale T publication id arrives or T restarts with new deps. | Publication carries node generation, hook slot, pass, and stage serial. Only the id attached to the winning alternate CASes; restart supersedes the old id. |
| retro-delivery under recycle | An edge created in a render queues T delivery; render discards, T retires, and its slot is requested for U. Add reentrant sync work while draining. | Slice-exit drains before host/commit; the slot retains `retroRefs`; envelope uses token+slot+watcher generations; retirement/recycle is deferred while bridge delivery depth is nonzero. No U column is touched by a T envelope. |
| watermark vs urgent | A locks T through `s1`; T writes `s2` post-await; urgent U commits with pin above `s2` but excludes T. | F3 reports the committed include set. Since T is absent, its watermark does not advance; U sees T only through old watermark `s1`. |
| paused pass vs lock advance | P captures root A lock view, yields, and another A commit wants to advance a watermark. | F2/F3 ordering ends P as discarded before installing the new same-root lock view. A live pass therefore sees one immutable view. |
| quiescence livelock | N refresh targets form a cycle in which each target writes whenever pulled. | Each target gets two failures, then is skipped and cone-carried. The sum of remaining strikes decreases on every failed attempt; a fixed graph reaches a write-free sweep in at most `2N+1` attempts. |
| compiled/uncompiled mix | Transformed A awaits an opaque uncompiled promise; only A writes after the await. | A's transformed continuation restores its token independently of how the promise settled. Carrier matrix test. |
| re-entrant actions | A continuation starts B synchronously; another independent C interleaves; rejection paths throw. | B shares A's token and increments its park ref; C has its own token. Every continuation push is `try/finally` restored and each settle decrements exactly its own ref. |
| worker wait | A awaits a worker response, then writes on the owner realm. | The owner continuation is transformed; no token crosses the worker. Raw Atom/ActionScope structured cloning is rejected. |

### 2.4 Cost attacks: no false victory

W1, W2, and W3 remain measurement risks, not wrong-value schedules. Their
concrete workloads and decision rules are in section 13. W5's comparator is
repaired by B4. No claim that W1/W2/W3 passes a numeric gate appears before the
registered runs.

## 3. Product scope and public semantics

- `Atom<T>({state, effect?, isEqual?, label?})`: tracked `.state`, `set`, and
  `update`. Observed 0-to-1 starts `effect`; 1-to-0 cleans it up. Both are
  microtask-flap-damped.
- `Computed<T>({fn(ctx), isEqual?, label?})`: lazy, cached, dynamically
  tracked, exact pull verification. `ctx.previous` follows section 9;
  `ctx.use(thenable)` stabilizes identity and `ctx.use(factory)` also suppresses
  duplicate construction. Error and suspension boxes are reference-stable
  cached outcomes.
- `ReducerAtom<S,A>` records actions and folds them in receipt order. A
  constructor reducer is immutable. Hook reducers stage like computed
  evaluators; swapping while receipts are pending warns in development.
- Core API: `effect`, `batch`, `untracked`, and `configure`. `batch()` delays
  core-effect flush only; it never groups or delays React delivery. Reads and
  writes inside replayed updater/reducer callbacks throw in every build.
- React API: `useSignal`, `useAtom`, `useReducerAtom`, `useComputed`, and
  `useSignalEffect`; no provider. Raw `startTransition` has parity in a
  carrier-capable build. `startSignalTransition(fn(scope))` adds the explicit
  `ActionScope` needed at opaque boundaries.
- Render-world writes always throw before mutation. Core computed writes are
  allowed when acyclic unless `forbidWritesInComputeds` is configured.
- Multiple roots have full per-root consistency. Cross-root simultaneous paint
  is not promised.
- No optimistic truncation API is exposed. A React batch that closes
  `committed=false` still folds its receipts.
- SSR serializes atom bases only at quiescence. Hydration restores bases before
  bridge registration; no RSC/Flight contract is added.

Terminology: a **token** is a stable integer identity for one React batch; a
**slot** is one of at most 31 recyclable bit positions for live tokens; a
**pin** is the global sequence observed at pass start; a **lineage** is a
fork-stable identity for retrying the same root/batch-set render; a **watcher**
is one mounted hook instance; a **receipt** is an atom operation tagged with
token, slot generation, and sequence; an **episode** is the interval between
two full quiescent resets.

## 4. Mechanism inventory (10)

1. **K0 and twin builds.** Closed arena donor; DIRECT contains no concurrency
   code, LOGGED shares state through a generated operation table.
2. **Receipt tapes and folds.** Base/baseSeq, ordered receipts, one global
   sequence, equality-stable replay, and prefix-only compaction.
3. **World registry.** Tokens, slots/generations, include masks, pins, immutable
   per-root lock views, watermarks, and per-root committed worlds.
4. **Closed cache validity.** Slot clocks, retirement and root-slot visibility
   stamps, evaluator stamps, memo epochs, world keys, and an audited
   change-source table.
5. **World memo and resource storage.** Generation-checked memo records,
   EVALUATING cycle marks, lineage/position thenable capsules, flattened
   content prefixes, and settlement back-references.
6. **K1 routing and retroactive reach.** Add-only real world edges,
   E-PRESERVE, `touchedSlots`, freshness-gated routing, edge-add propagation,
   and generation-bearing retro queues.
7. **Per-write notification.** Full K0-union-K1 walks, writer-token `setState`,
   per-watcher/slot pending bits, render re-arm, and targeted effect enqueue.
8. **Bindings and staging.** Watcher records, mount fixup, reconciliation,
   committed effects, fresh-node staging, evaluator staging, and F9
   hook-grain publication.
9. **Versioned fork/build protocol F1-F9.** Classification, pass slices,
   retirement/lock-in, lane execution, lineage, mutation window, handshake,
   continuation carrier, and hook publication.
10. **Lifecycle.** Pin retention, deferred compaction, two-strike quiescence
    refresh with cone carry, staging reclamation, allocator generations,
    horizons, and trace buffers.

These are inventory units, not claims that each has one field. No optional
cost fallback is counted until adopted.

## 5. K0, modes, layout, and graph semantics

K0 uses one interleaved `Int32Array` plane for node and link hot fields and one
dense, never-holey `unknown[]` value/fn side column. Integer ids are premultiplied
record offsets. Dependency re-tracking uses a tail cursor; walks are iterative
with persistent typed scratch. Growth happens only at operation boundaries by
rebuilding closures over larger buffers. Node/link split, same-file const enums,
and bytecode budgets preserve the measured donor shape. Policy wrappers handle
custom equality, errors, and suspension; K0 compares stable identities.

DIRECT's exported functions are the donor functions, not LOGGED functions with
a false branch. Bridge registration is monotone and swaps the operation table
once. It is keyed to bridge presence, never watcher count. Packed side columns
stay index-aligned with the plane; values are not moved into entity objects.

K0 owns newest-world push-pull semantics: a write marks downstream maybe-dirty;
a pull verifies bottom-up and recomputes only changed nodes; equal results cut
propagation. Dynamic edges are removed/reused by the donor cursor. Core cycle
detection and React's update limits reject loops. A throwing getter finishes
dependency bookkeeping and caches an error/suspension box before rethrowing.

K1 has the same edge direction but is a cold, separate plane. A world evaluation
records the actual dependency edges it read. Edges are add-only for an episode,
so discarded work may over-notify. K1 stores links and touched bits, never
values; reads still fold receipts, and a reached effect revalidates committed
dependency values before its user callback. Therefore a discarded edge can add
a render/recheck but cannot supply a value or by itself fire an effect callback.
When K0 retracks while K1 is active, E-PRESERVE mirrors required basis edges; a
development validator compares the union against brute-force reach.

## 6. Receipts, worlds, and visibility math

### 6.1 Logged write path

```text
write(atom, op):
  if renderFrame || worldEvalFrame || foldFrame: throw before mutation
  demote every live RENDER_NEWEST binding to its frozen world
  token = fork.currentBatchToken()       // continuation-aware; lazily minted
  slot, slotGen = intern(token)
  seq = ++globalSeq
  slotWriteSeq[slot] = seq
  if tape empty: atom.base = K0.value(atom)
  append {op, token, slot, slotGen, seq, retiredSeq: 0}
  K0.writeNewest(atom, stableApply(op, K0.value(atom)))
  fullNotifyWalk(atom, token, slot, slotGen)
```

The receipt is appended even when newest equality holds. With any history, an
excluded world can have a different accumulator. With an empty tape only, an
equal operation may be dropped after one evaluation against base.

### 6.2 Frozen worlds

A pass world is
`{rootId, rootGen, includeMask, pin, lockViewId, episodeEpoch}`. At pass start
the binding captures `pin = globalSeq` and copies the root's at-most-31 locked
records into a pooled immutable lock view:
`{slot, slotGen, watermark, lockStamp}`. A committed-for-root world has no
include mask, a current pin, and the root's current immutable view. NEWEST uses
K0 directly.

Receipt `e` is visible in world `w` iff:

```text
(e.retiredSeq != 0 && e.retiredSeq <= w.pin)
|| (matching slot generation is in w.includeMask && e.seq <= w.pin)
|| (matching slot generation is in w.lockView
    && e.seq <= min(w.pin, lock.watermark))
```

`foldAtom` starts at `base`, scans receipts in sequence order, applies each
visible operation, and after each step keeps the old reference when
`isEqual(old,next)`. Reducers use the pass-staged reducer only inside that pass;
all other folds use the committed reducer.

### 6.3 Root lock armor and visibility fingerprints

Only F3's `tokenCommittedOnRoot(token, root, committedPass)` event may alter the
token's root record, and only when `token` is in that pass's exact include set.
The new watermark is `max(old, committedPass.pin)`. One `++globalSeq` lock stamp
is stored with the new `(root,slot,slotGen)` record. Unrelated commits do
nothing. Before a same-root lock view changes, F2 ends all older open passes;
other roots have separate records.

Retirement first stamps matching receipts with `retiredSeq = ++globalSeq`, then
sets `retireVisStamp[a]` to a later `++globalSeq` for every touched atom before
clearing root lock records. Define:

```text
lockTerm(a,w) = max(lock.lockStamp for locked slots having any visible
                    receipt of a at or below that lock watermark, else 0)
fp(a,w) = max(newest visible receipt seq, baseSeq(a), reducerStamp(a),
              retireVisStamp(a), lockTerm(a,w))
```

Over-invalidation inside one root-slot is allowed; cross-root invalidation is
not.

**Visibility-change construction.** Base case: with no receipts or lock
records, `fp` names the base/evaluator state. Induction step for a write: either
the new receipt is visible and its new sequence becomes the newest term, or it
is invisible and this world's content does not change. Step for retirement:
every atom whose visibility set can change receives a newly minted
`retireVisStamp`, greater than every prior term. Step for initial lock or
watermark advance: every newly visible receipt belongs to the advanced slot,
whose captured new lock stamp is greater than every prior term. Step for lock
clear at retirement: the later retirement stamp remains after the lock term is
removed. Step for another root: the world has no record for that root, so
neither fold nor fingerprint changes. Thus every visibility flip for this
world moves `fp`; no claim is made that every `fp` move changes the value.

### 6.4 Rebase construction

Base is the value before the first uncompactable receipt. Every world selects
receipts using exactly the three clauses above, but never reorders them. Adding
a receipt appends one operation; retirement changes selection, not order;
prefix compaction replaces an all-retired prefix by the result of replaying
that same prefix. Therefore induction over receipt append/retire/compact yields
the same accumulator as React's skip-and-replay queue. A later receipt is never
compacted past an older unretired receipt.

## 7. Routing, reach, and retroactive lane delivery

### 7.1 Read rule

An atom in a non-newest world always folds its tape. A computed may use K0 only
if (a) the pass is still RENDER_NEWEST, or (b) `touchedSlots(node)==0` and the
K0 cache is already clean/current without invoking its evaluator. Dirty,
uninitialized, or fresh nodes world-evaluate. The first logged write demotes
all live RENDER_NEWEST bindings to their originally captured worlds. The fork's
slice enter/exit callbacks make render context callstack-scoped, so a handler
in a yield gap reads NEWEST.

### 7.2 Touched invariant and proof

`touchedSlots(n)` has bit s iff slot s's receipt influence may reach n in the
episode. A 0-to-1 transition appends n to `touchedList[s]`.

Invariant M: if a live-episode receipt in slot s starts at atom x and a path
`x -> ... -> n` exists in K0 union K1, then n has bit s.

- Base: the write walk visits x and every then-existing out-edge, setting s.
- Existing-edge step: a later write performs the same full walk.
- New-edge step: recording `d -> n` computes
  `newBits = touchedSlots(d) & ~touchedSlots(n)`, ORs them into n, then recurses
  through all existing out-edges. It also performs retro-delivery below.
- World-evaluation step: the result node ORs the union of every dependency's
  bits; edge insertion handles transitive out-edges.
- Edge removal is only from K0; K1 retains the union edge until quiescence, so
  removing cannot falsify reach. Slot recycle clears all s bits only after the
  token has no live receipt or retro reference.

These events exhaust path creation and receipt creation, proving M by
induction. Equality never stops these metadata walks.

### 7.3 Delivery completeness and slot-recycle armor

When edge propagation introduces bit s, every watched node reached gets one
delivery obligation. Outside render it immediately calls
`runInBatch(ownerToken, setState)`. Inside render it appends a fixed record:

```text
{tokenSerial, slot, slotGen, watcherId, watcherGen, causeSeq}
```

F2 calls `sliceExit` after the render callstack is gone and before yielding to
host code, exposing a pass to commit, or reporting discard. The bridge drains
the queue there, including on discard. A live matching token uses `runInBatch`;
a token that retired meanwhile requests an urgent pre-paint correction. A dead
watcher generation is ignored.

Each queued record increments `slot.retroRefs`. Retirement marks the slot
RETIRING, drains its obligations, sweeps touched/watcher columns to the final
list length, and releases only when `unsweptEntries==0`, `retroRefs==0`, and
bridge delivery depth is zero. Reentrant renders may append obligations, but
recycle is deferred until the outer bridge callback returns. Generation is
incremented before reuse.

**Delivery construction.** A receipt's initial walk delivers every watcher on
an existing path. If a later edge creates the first path, M's new-edge step
propagates its bit and creates an obligation. If a watcher mounts after both,
mount fixup observes the bit. If the token retires before either can join its
lane, retirement reconciliation/pre-paint fallback observes committed state.
These are the only orderings of receipt, edge, watcher, and retirement; hence a
watcher is scheduled in-token or corrected before paint. The generation and
retain conditions prevent an obligation from becoming one for a recycled slot.

## 8. World memos and the closed validity table

A world memo is keyed by node generation plus the complete frozen world key.
Its states are EMPTY, EVALUATING, and DONE. Reading EVALUATING throws the core
cycle error. A DONE record holds outcome box, evaluation sequence, memo epoch,
effective evaluator stamp, included-slot clock snapshot, and resource backrefs.
It is reusable only when every applicable observer below still matches.

| source of a world-visible result change | observer | reset/lifetime |
|---|---|---|
| receipt append | `slotWriteSeq[s]`, memo evaluation seq, newest-visible receipt term | slot clear after all receipts/queues are gone |
| retirement or compaction | `worldMemoEpoch`, `baseSeq`, `retireVisStamp[a]` | epoch/global sequence rules |
| root initial lock or watermark advance | immutable lock-view id and captured root-slot `lockStamp` | view retained by passes; current record clears after retirement |
| evaluator/reducer identity | effective staged or committed stamp | stage publication/discard |
| thenable settlement | capsule generation and memo backref | lineage death/entry replacement |
| world identity | root/gen, mask with slot gens, pin, lock-view id, episode | exact in key |
| node identity | node generation | deferred free and generation increment |
| sequence renumber/episode reset | episode epoch | quiescent reset invalidates old keys/snapshots |

The fast predicate is integer comparisons. Failure runs the validity ladder:
re-fold atoms, pull dependencies, and re-evaluate only if an equality-stable
outcome actually differs. `worldMemoEpoch` may conservatively invalidate a
held world after an unrelated retirement; G-E measures that cost. The table is
the complete list: schema generation emits storage, reset sites, a development
sweeper, and a test that mutates each source while holding all others fixed.

## 9. Evaluator identity, `ctx.previous`, and Suspense

### 9.1 Hook-grain staging and F9 publication

Every hook node has one committed `{fn, deps, stamp}` (or reducer). Every pass
has a cold stage table keyed by `(passId, nodeId, nodeGen, hookSlot)`. A hook
invocation compares deps with that pass's stage if present, otherwise with the
committed entry. Changed deps mint a new global-sequence stamp and replace only
that pass's stage. A same-pass render restart repeats this comparison. Pass
world evaluation selects its exact stage; NEWEST, committed effects, fixup,
and reconciliation select the committed evaluator.

When a stage is used, the binding calls F9 with its opaque publication record.
The fork attaches the id to the exact WIP hook slot. When that hook becomes
current, even under hidden Offscreen, F9 emits the id before layout effects.
Promotion is a CAS on `(nodeGen, hookSlot, passId, stageStamp)`. The commit then
emits `publicationsComplete(passId)`, which reclaims every unpublished stage.
Discard and lineage-death reclaim without promotion. A bailout that reuses an
already-current fiber has no new id and needs no promotion.

**Selection construction.** Initially every context uses the committed
evaluator. A render-stage event changes only one pass's table. A discard emits
no publication, so committed state is unchanged. A commit emits exactly ids on
winning hook slots; each successful CAS makes the committed evaluator equal to
the evaluator that produced that committed hook. Error-abandoned slots are not
winning; hidden slots are. A later/stale alternate cannot satisfy the CAS.
Induction over stage, discard, and commit therefore keeps every pass on its own
closure and every committed context on the winning closure.

`ctx.previous` has three explicit meanings:

- NEWEST/RENDER_NEWEST: K0's donor-global previous value;
- a world evaluation: the prior DONE memo for the exact world key;
- first world evaluation: K0's value only when the read-routing cleanliness
  guard proves it is a valid seed; otherwise `undefined`.

### 9.2 Positional resource capsules

`ctx.use` uses `(nodeGen, lineageId, position)` identity. Before each position,
the evaluation frame appends an ordered, flattened prefix of every transitive
tracked atom read `(atomId, fp(atom,w))` and every traversed computed
`(computedId, effectiveEvaluatorStamp)`. Child frames append directly into the
parent target with a loop; no allocation-heavy array combinator is used.

Reuse requires pairwise prefix equality. Mismatch drops this and later
positions and increments entry generation. `ctx.use(factory)` invokes its
factory only on a miss. Eager `ctx.use(thenable)` guarantees returned identity,
not suppression of the caller's already-performed side effect.

Settlement validates entry generation, kills every referenced SUSPENSION memo,
and asks React to retry. Effects whose committed snapshots ended in SUSPENSION
are enqueued for a committed recheck. A stale settlement is a no-op. Lineage
death drops capsules whether settled or not.

**Identity/content construction.** For a pure retry with the same world
content, tracked read order and evaluator stamps are identical, so the prefix
matches and the same thenable is returned. A relevant write moves a visible
receipt term; an older-entry visibility flip moves the retirement or captured
root-slot stamp; an evaluator change moves its stamp. An unrelated root lock is
absent from this world's lock view, and an unrelated atom never enters the
prefix. Thus stable retries reuse while every enumerated content change misses.
Purity is enforced by the render/world write guard and fold-read guard.

## 10. Notification, watchers, effects, and late joins

Every logged write runs a non-pruning iterative walk over K0 union K1. It sets
the slot's touched bit and enqueues each reached committed signal effect once.
For a watcher, `(watcher, slotGen)` has a pending-delivery bit. If clear, the
walk sets it and synchronously calls `setState` under the current writer token.
Rendering that watcher clears its bits for the rendered tokens, because any
later write must invalidate finished-but-uncommitted work. There is no
canonical-value or cross-write equality suppression.

`batch()` changes only core-effect flush timing. Therefore

```ts
batch(() => {
  a.set(1)
  startTransition(() => b.set(2))
})
```

delivers `a` in its urgent/default token at its write and `b` in the transition
token at its write. No grouped drain has to reconstruct context.

Mount layout fixup, after F3 lock bookkeeping and F9 publication, does:

```text
bits = touchedSlots(renderedNode)
for each live written token whose current slot generation is in bits:
  runInBatch(token, setState(watcher))
now = evaluate(renderedNode, committedForRoot)
if !isEqual(now, valueRendered): scheduleUrgentPrePaint(setState(watcher))
```

It is reach-based, not equality-filtered per token. If a token retired in the
render-to-layout window, the unconditional committed compare catches it. An
update inserted into completed-but-not-committed lanes is required by F4 to
schedule new work, never mutate the completed tree silently.

`useSignalEffect` records committed dependency values plus fingerprints. Its
flush triggers are root commit/lock, retirement, and settlement. Only effects
reached by touched walks enter the queue. A moved fingerprint causes dependency
revalidation; the user callback runs only if an equality-stable dependency
value/outcome changed. This avoids spurious callbacks from conservative stamps.
Core `effect()` observes NEWEST and is synchronously observable under the
benchmark configuration.

Atom observed-lifecycle counts committed watchers and effects. StrictMode's
mount/unmount flap is microtask-damped, so one logical subscription produces
one start and one eventual cleanup.

## 11. Async actions and the build prerequisite

### 11.1 Carrier selection and build ABI

The runtime ladder is:

1. native standard `AsyncContext`, when present and passing the probe;
2. the I30 twin-build transform;
3. optional Node AsyncLocalStorage only when explicitly selected for server
   compatibility, not as the browser performance claim;
4. otherwise fail bridge/action startup loudly.

The transform compiles each async function to a native body plus a
token-carrying generator driver. A single carrier-null check chooses the native
body; only an armed action pays the driver. The bundler emits a manifest with
carrier ABI version and every transformed first-party chunk that imports the
signal write/action surface. On bridge registration a transformed probe checks
native await, a timer, catch/finally restoration, two interleaved actions, and
the build/runtime ABI. Missing or mismatched coverage fails before actions run.

The probe proves installation, not opaque-library behavior. Externals may be
awaited and may synchronously call into the action. If they themselves write a
signal after an untransformed async boundary, U1 applies.

### 11.2 Parking, re-entrancy, and explicit scopes

An action record is `{ownerRealm, token, generation, parkRefs, state}`. Starting
an action with no carrier mints a token. Starting one while a live action frame
is active reuses that token and increments `parkRefs`. Every transformed async
resource captures the record; immediately before its continuation the driver
pushes it, and `finally` restores the prior frame. Fulfillment or rejection
decrements exactly one ref. F3 may retire only when refs, React work, and remote
scope leases are all zero. Rejection does not drop receipts.

`startSignalTransition` passes an `ActionScope` with owner-bound methods:

- `scope.set(atom, value)` and `scope.dispatch(reducerAtom, action)` explicitly
  supply the captured token after checking record generation and liveness;
- `scope.runSync(fn)` enters the carrier only for the synchronous dynamic
  extent. It deliberately does not promise to carry an untransformed returned
  thenable;
- calls after action settlement throw `ActionScope closed`.

This makes an opaque callback safe when it uses the scope method, without
pretending raw ambient writes are identifiable.

### 11.3 Realms and workers

Atoms, action records, tokens, and fork roots carry an owner-realm nonce. A
foreign token presented to `runInBatch` throws. Same-origin realm code may call
an owner-bound `ActionScope.set`; raw `atom.set` after a foreign realm's await
has no ambient guarantee. Atom and ActionScope are not structured-cloneable.
Workers may compute/await data; a transformed owner-realm continuation or a
message handler using an explicit owner scope applies the result. V1 exposes no
serialized token or remote-write protocol. This restriction is detectable at
the attempted clone/token-import boundary and does not forbid ordinary worker
promises.

Support matrix:

| composition | status |
|---|---|
| transformed action awaits native or opaque promise, then caller writes | supported |
| uncompiled code writes synchronously while called under carrier | supported |
| uncompiled post-await code uses `ActionScope.set/dispatch` | supported |
| uncompiled code performs raw post-await signal write | unsupported; U1 |
| two independent/re-entrant transformed actions | supported |
| worker returns data; owner continuation writes | supported |
| raw token/Atom/ActionScope structured clone | rejected |

## 12. Retirement, quiescence, allocation, and counter soundness

### 12.1 Retirement and pin release

For token t:

1. mark RETIRING; stamp all t receipts `retiredSeq=++globalSeq`;
2. for every atom in t's touched list set `retireVisStamp` to a later global
   sequence and enqueue it for fold/compaction;
3. fold only the maximal all-retired prefix not retained by any live pass pin;
   update `base`, `baseSeq`, and `worldMemoEpoch`; blocked atoms join a
   pending-compaction list;
4. perform the plain retirement reach/reconcile path and drain targeted
   committed effects;
5. remove t from every root lock view after the retirement stamps exist;
6. drain retro obligations, clear touched/watcher slot columns to fixed point,
   and release the slot only under section 7.3's retain conditions.

`committed=false` changes none of these steps. Pass end and lineage death
advance the minimum live pin and revisit pending compaction. F3 guarantees root
lock/retirement bookkeeping and F9 publication finish before layout effects.

### 12.2 Quiescence refresh with a terminating exemption

Quiescence requires no live token/pass/lineage, no retained tape entry, no
retro obligation, and drained compaction. Build a typed worklist of every
K1-touched node with a committed watcher, plus every K1-touched computed in a
committed effect dependency snapshot.

For a target with fewer than two refresh failures, K0-pull it at NEWEST under a
`refreshTarget` frame. If any nested computed writes, increment that target's
saturating failure count, abort the reset, allow the new token to settle, and
restart the entire worklist at the next quiescence. On the second failure mark
the target exempt. Exempt targets are not pulled; before reset traverse their
K1 dependencies backwards to a fixed point and copy every encountered K1 edge
into the fresh plane. Mixed K0/K1 paths remain connected because K0 persists.

If a full sweep has no write, install the copied cone, bump episode epoch,
reset the old K1 plane and all zero-live-slot touched state, drop dead world
keys/capsules, reclaim staged records, and optionally renumber. Any ordinary
K0 NEWEST evaluation of an exempt target that completes without increasing the
write counter clears its exemption for the next reset.

**Termination construction.** For a fixed candidate set define
`R = sum(2 - failures[target])` over nonexempt targets. Initially `0 <= R <=
2N`. Every failed sweep increments one target or exempts it, strictly reducing
R. Exempt targets are skipped and cannot write during refresh. Therefore after
at most `2N` failed attempts the next attempt is write-free and resets. If user
effects create an unbounded sequence of new observed nodes, the fixed-set
premise is false; the existing signal-only operation budget detects and throws
the infinite loop rather than claiming quiescence.

### 12.3 Counter and retained-state table

| counter/id | retained by | safe reuse/reset and forced test |
|---|---|---|
| `globalSeq` | receipts, pins, retire/base/visibility/evaluator stamps, memo epochs | renumber only at quiescence with episode bump and retained-column rewrite; hard diagnostic before unsafe horizon; forced-small quiescent and never-quiescent tests |
| token serial | registry, receipts, retro queues, scopes | never reuse live; wrap scans live serials; forced 3-bit allocator |
| slot generation | masks, receipts, touched/watcher columns, lock views, queues | increment after fixed-point clear and zero retain counts; forced one-slot recycle |
| episode epoch | world keys, memo/effect snapshots, K1 records | bump per reset; wrap performs full clear before reuse |
| node generation | wrappers, links, stages, capsules/backrefs | deferred free; increment and clear record; stale settle/publication tests |
| K1 plane tag | K1 ids/links | tag bump; physical clear on tag wrap |
| root id/generation | worlds, lock views, effects | unregister ends passes/lineages and clears records before id reuse |
| lock-view id/generation | pass worlds | pooled record retained until every pass drops; overwrite only after generation bump |
| pass id/generation | stage and retro queues | complete/discard/publication sweep before reuse |
| lineage id/generation | capsules and retries | fork death callback drops all entries before reuse |
| publication serial | WIP hook and stage table | CAS plus commit/discard sweep; forced stale-alternate delivery |
| watcher generation | retro queue and delivery bits | increment on unmount; queue validates; full clear at wrap |
| capsule entry generation | settle callbacks/backrefs | increment on replacement; lineage drop or wide-counter hard stop before wrap |
| refresh failures | node generation | saturates at two; cleared only by generation change or successful ordinary K0 evaluation |

Node creation during render is staged outside K0's permanent allocator. F9
publishes committed nodes; discard/StrictMode replay reclaims them. All steady
walk stacks, pass lock views, retro queues, worklists, and trace records use
preallocated planes/rings. Growth is an operation-boundary event, not steady
render allocation.

## 13. Performance gates and the W attacks

Numbers marked measured come only from the frozen research facts. Everything
else is a gate awaiting its named isolated-process run.

| gate | budget / comparator | status and remedy rule |
|---|---|---|
| G-D | DIRECT at or below alien-signals v3 on every tier-0; 179/179 with exact pulls and growth stress | donor existence measured; byte/symbol diff in CI |
| G-Q | LOGGED-quiet target <=2%; known measured branch floor 2.4-3.8% means AT RISK | SPK-L on idle machine; if confirmed, present <=3% renegotiation and routing-hoist/fused-load results rather than silently moving gate |
| G-W | one logged write <=2x DIRECT | SPK-W; failure compares inline-two receipts and tape pooling |
| G-N | full notification <=2x DIRECT propagation; <=1 spurious render per `(watcher,slot,watcher-render-cycle)` | SPK-N1/W1; no value cutoff. Per-slot pending masks are the only pre-approved dedup, not traversal pruning |
| G-F | R-clean mount zero fixups; flagged mount <= touched-live-token count plus one committed eval; 10k mount <=15% equivalent useState | W2; failure alternatives must be measured separately: vectorized F4 bridge crossing, reconciler-native remaining-lane update, or scope renegotiation |
| G-E | world evaluation proportional to flagged region and restart-heavy typeahead within 10% equivalent React recompute | SPK-G8/W3; compare exact-pin default against content-keyed frontier plus pass-local `previous` scratch before adoption |
| G-R-core | retirement engine overhead <=2x DIRECT `batch()` on identical writes/effect graph; report mandatory user callback time separately | SPK-R/W5; corrected B4 denominator |
| G-R-react | retirement reconciliation <=2x equivalent useState render/commit for reached watchers | SPK-R |
| G-P1 | signal rerender <=10% useState; 10k subscription mount <=15% | harness with 0 and 10 live tokens |
| G-M | zero JS allocation on steady rerender; report heapUsed and plane bytes | allocation profiler plus plane high-water marks |

### W1 — held-batch fan-out

One atom feeds one computed and 10,000 watchers. An async T writes the atom once
per animation frame for 120 frames while a sibling keeps T suspended; after
each write React is allowed to render all watchers and re-suspend, re-arming
their T delivery bits. Record node visits, `setState`s, render attempts, plane
growth, and time against DIRECT and 10,000 colocated `useState` consumers.

The sound bound is 1,200,000 watcher deliveries and one full reach walk per
write; it is not claimed cheap. Pending bits remove duplicate deliveries only
when a watcher has not rendered since the prior one. Pruning at a shared node
is forbidden because re-arm is watcher/slot-specific. Gate failure remains an
open cost result; no equality suppression is an admissible repair.

### W2 — mount under ten excluded live tokens

Ten live tokens each wrote the same atom. A Sync-only pass excluding all ten
mounts 10,000 watchers of its computed. Every fixup sees ten touched live bits:
100,000 `runInBatch` corrections plus 10,000 committed evaluations. Compare
with useState mount and report JS-to-fork crossings separately from React queue
entries. Correctness requires all ten lane obligations; the spike decides
whether vectorizing the seam helps or a deeper remaining-lane update is worth
its proof/rebase cost.

### W3 — restart-heavy exact-pin worlds

A 5,000-node flagged graph is rendered by a held transition. Thirty urgent
keystrokes interrupt after 25%, 50%, and 75% progress, producing new pass pins
but the same logical lineage. Measure recomputes, prefix comparisons, and wall
time. Exact-pin world keys may pay the flagged region each restart. The
candidate fallback shares only a content-validated frontier by
`(mask, immutableLockView, episode)` and keeps each pass's `ctx.previous` in
pass-local scratch; it is not adopted until it beats the default and passes
C7/C13/dual-root previous-value fuzz.

### W5 — dense retirement and effects

Variant A: a store-only token writes 10,000 atoms; 5,000 effects each read two
assigned atoms. Variant B: each effect reads all 10,000 atoms but changes only
at the final dependency. Run equal-result and changed-result forms. Compare
folding, queue dedup, fingerprint scan, and mandatory callback evaluation with
DIRECT `batch()` on the same graph. Assert no registry-wide effect scan and at
most one queued entry per affected effect/retirement. The old render-relative
gate is deleted; a zero-render batch is a required case, not a free pass.

## 14. `fork-protocol` — 9 versioned seam touch-points

Only integers, booleans, and callbacks cross this boundary. No Fiber, lane
bitmask, update queue, or host object does. Inert sites perform one listener
null-check.

1. **F1 — write classification and token.** `currentBatch()` returns a stable
   integer token plus deferred/default/urgent class, lazily minting as needed.
   A continuation carrier overrides ambient classification only while its frame
   is pushed.
2. **F2 — pass and render-slice lifecycle.** Start supplies root id/gen, exact
   included token integers, and lineage id. Enter/resume establishes callstack
   render truth. Slice exit for yield, complete, and discard runs after render
   truth is cleared but before host control or commit eligibility; it drains
   retro delivery. Pass end identifies complete versus discard. Before a
   same-root lock state advances, every older open pass on that root receives
   discard/end.
3. **F3 — batch/root lifecycle.** Claim, pending, async park/unpark, finish,
   exact-once retire with `committed`, and
   `tokenCommittedOnRoot(token, root, committedPassId)`. The last event is sent
   only for tokens in that pass's exact include set. Lock bookkeeping,
   retirement folds due at that commit, and F9 publication finish before that
   root's layout effects.
4. **F4 — lane-scoped scheduling.** `runInBatch(liveToken, callback)` makes
   callback updates join that token's lanes. Work inserted after a pass
   completed but before commit schedules further work for those lanes; it is
   never absorbed into the finished tree. `scheduleUrgentPrePaint(callback)`
   is the dead-token correction and must run before the next paint.
5. **F5 — render lineage.** A stable integer per root and logical batch-set
   survives retry/replay and dies on commit or abandonment. Root-lock changes
   do not churn identity; content stamps decide reuse.
6. **F6 — DOM mutation window.** Begin/end callbacks let committed effects and
   urgent corrections avoid user callbacks in the mutation interval.
7. **F7 — version/feature handshake.** The binding requires the exact protocol
   major, feature bits F1-F9, and carrier ABI. Stock or skewed React fails
   loudly; there is no `useSyncExternalStore` fallback.
8. **F8 — action lifetime and continuation identity.** The registry parks
   action tokens; native AsyncContext or the transformed driver pushes/restores
   the token for each continuation. Parking and identity are separate tested
   duties.
9. **F9 — hook publication.** Render attaches an opaque publication id to an
   exact WIP hook slot. Commit emits ids for hooks made current, including
   hidden Offscreen; then emits completion for the pass. Discarded/error-
   abandoned/stale alternate hooks do not publish.

Approximate fork anchoring is 16 reconciler/runtime sites: lane selection/token
claim; render start; slice enter; three slice exits; root token commit;
retirement; lane override; pre-paint queue; lineage create/death; mutation
begin/end; handshake; action runtime; hook attach; hook publish/complete. The
exact file count is an implementation output, not fabricated here.

### Rebase drill

- Lane names, masks, or update queue representation change: only F1/F4's fork
  implementation moves; token/integer semantics and the signal library do not.
- Render work-loop/yield sites move: re-anchor F2 and run slice-order tests; no
  library type changes.
- Commit phases or Offscreen effect behavior change: re-anchor F3/F6/F9 to the
  event "hook becomes current before user layout"; no evaluator rule changes.
- Action implementation changes: F3 parking and F8 carrier tests identify the
  new anchors. The transform ABI is versioned separately.
- Root or lineage internals change: the fork remints the same root/lineage
  integers. No Fiber crosses the seam.

### Fork-owned tests

1. urgent/default/deferred classification and lazy stable tokens;
2. 31-live-token bound, live-skip allocation, committed-false retirement once;
3. pass exact include set for single and joint renders;
4. handler during yield sees no render frame; resume restores the same pass;
5. retro queue drains before host callback, commit eligibility, and on discard;
6. retirement during a pinned pass preserves that pass's world;
7. multi-root token commits report roots independently and retire once;
8. unrelated urgent commit does not advance another token's watermark;
9. watermark equals max prior/committed pass pin; post-await receipt stays out;
10. same-root lock advance discards every older open pass first;
11. `runInBatch` joins live lanes and completed-pass insertion schedules work;
12. dead-token urgent correction completes before paint;
13. lineage stable across retry/StrictMode and dead on commit/abandon;
14. mutation begin/end nesting and inert null checks;
15. stock React/version skew/carrier ABI fail loudly;
16. native await, timer, Promise.all, async generator, catch/finally carrier;
17. two independent actions plus re-entrant shared-token park refcounts;
18. unsupported-host and uncompiled-boundary diagnostic paths;
19. F9 child error abandonment publishes sibling only;
20. hidden Offscreen commit publishes before reveal and before layout;
21. stale alternate/publication generation cannot overwrite winner.

## 15. Correctness battery

Notation: `tape(a)` is the receipt tape; `TS(n)` is `touchedSlots(n)`;
`Lr[s]=(watermark,lockStamp,slotGen)` is root r's lock record; `M(n,w)` is a
world memo; `Qretro` is the retro queue. Every residual names its pinning test.

### C1: world-divergent dependency and all seven seed variants

Main schedule, `flag=false, a=0, b=0, c=flag?a:b`, W watches c:

| step | actor/mechanism | state touched (values, marks, edges, log, lanes) |
|---|---|---|
| 1 | deferred k writes `flag=true`; receipts + notify | append `(set true,k,s1)`; K0 newest flag=true; K0 path `flag->c->W` gets TS k; W gets k-lane update; committed fold still false |
| 2 | k-world reads c before `a` write; routing + K1 | c is touched, so world-evaluate: flag=true, a=0; `M(c,wk)=0`; real K1 edges `flag->c`, `a->c`; edge propagation carries TS as applicable |
| 3 | W renders that update | c=0 in wk; W clears its pending k bit, so later k writes can schedule finished work again |
| 4 | k writes `a=1`; receipts + union walk | append `(set 1,k,s2)`; slot clock moves; K1 path `a->c->W` exists; memo invalid; TS k propagated; W gets a new k-lane update |
| 5 | k re-renders | fold flag=true and a=1; c recomputes 1; committed-for-root still flag=false and reads b=0 |
| 6 | k commits/retires | F3 locks/then retires as applicable; visibility stamps move; prefix compaction preserves order; DOM and committed c are 1 |

outcome: k's c becomes 1 and W has k work before commit; the committed world
stays 0 until k commits.

residual risk: real K1 edge and re-arm completeness; pin with the C1 main test
plus an assertion that step 4 creates a second update after step 3.

Variant traces:

| variant | actor/mechanism | state and outcome |
|---|---|---|
| T2: k writes committed-only dep b | receipt and full walk may deliver; wk has flag=true so re-evaluation still selects a; committed excludes k. Over-render only. |
| T3: k flips flag back false | slot clock invalidates; K1 records/retains `b->c`; fold selects b and W is k-scheduled. |
| T4: urgent U writes b | U receipt is always logged. A k pass pinned before U stays unchanged; after U retires, k can see b but still selects a while flag=true. Committed c changes only when its actual branch uses b. |
| T5: urgent U writes a | U render excludes k and folds a from base; after U lock/retire, a is visible to k by lock/retired clause, slot clocks/stamps invalidate, and k computes from it. |
| T6: slot reuse | k retirement drains receipts/retro refs and clears TS/watch/lock columns, increments slotGen; a forced U reuse cannot match k's tape, pass mask, or queue records. |
| T7: two batches joint then one alone | joint world key has both slot generations and real edges; single world has one. Memos are distinct. If T2 commits alone, root lock view changes only for T2; T1's pending delivery survives and its later render folds retired T2 plus included T1 in seq order. |
| retro edge after old write | T1 writes a before any edge. A joint pass later records `a->c`; new-edge propagation sees TS(a) T1 and queues `{T1,gen,W}`. Slice-exit drains even if the pass discards; T1 cannot commit through a bailout. |

outcome: every C1 family member either recomputes its actual world or
over-notifies safely; no canonical-only topology claim is used.

residual risk: subset/world fuzz; differential test all nonempty subsets of up
to five tokens and random retire/lock order.

### C2: Sync render excludes a pending default batch

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | default D writes a=1 | receipt `(D,s1)` appended before K0 newest becomes 1; TS propagates to c/W |
| 2 | Sync-only pass starts | include mask excludes D; pin and root lock view captured |
| 3 | reads a and c | atom fold excludes D =>0; c is touched, so cannot use K0 cache 11; world-evaluates from a=0 =>10 |
| 4 | optional mount fixup | D is live+written and its bit reaches node, so fixup `runInBatch(D)`; D's later render includes W |

outcome: one frame contains a=0 and c=10; D later commits both as 1/11.

residual risk: accidental urgent fast path; test checks a direct atom and one-
and three-level computed cones, with a fresh mount.

### C3: updater/reducer rebase parity

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | T `update(+1)` | base 1; tape s1:T +1; K0 newest 2 |
| 2 | U `update(*2)` | tape s2:U x2; K0 newest 4; both receipts retained |
| 3 | urgent render/commit | U world skips s1, applies s2 to base =>2; U retires but s2 cannot compact past unretired s1 |
| 4 | T render | includes s1; retired clause includes s2; seq replay `(1+1)*2=4` |
| 5 | T retirement | now all-retired prefix compacts to 4; canonical is 4 |
| 6 | plain-set variant | `+1` then later `set 5` replays to 5, never 6 |
| 7 | custom equality | equality is applied after each operation against that world's accumulator, preserving the same reference K0 would preserve |

outcome: visible sequence is 2, 2, 4, 4 and reducer differential matches
React.

residual risk: compaction crossing a gap; randomized operation oracle includes
sets, functional updates, reducers, and nontrivial equality classes.

### C4: a second batch writes an already-stale region

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | T1 writes a | full walk sets TS T1 and delivers W in T1 |
| 2 | before W renders, T2 writes a | full walk runs again despite stale K0 marks; sets TS T2; watcher pending state is keyed by slot, so delivers W in T2 |
| 3 | renders | each token's render has its own update and fold |

outcome: W is scheduled in both lane sets; once-per-staleness is not a delivery
mechanism.

residual risk: shared dedup regression; test asserts two update queue lane
obligations before any render.

### C5: equal first result, effective second write in one batch

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k writes a 0->1 where `c=a*0+b` | receipt and value-blind reach walk occur; K0 equality may keep c; slot clock invalidates world memo; W has at least one k update |
| 2 | optional W render | if React renders between writes, its k delivery bit re-arms |
| 3 | k writes b=7 | second full walk cannot stop at stale marks; memo clock moves; W is already pending or gets a newly re-armed k update |
| 4 | k render | fold reads b=7; c=7 |

outcome: the second write reaches or is covered by still-pending k work, and no
first-evaluation cache validates.

residual risk: pending-bit semantics; test both with and without the interposed
render.

### C6: lane attribution with explicit `batch()`

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | outer `batch` opens under urgent/default context | only core-effect flush depth changes |
| 2 | `a.set(1)` | immediate receipt/walk/setState under outer token |
| 3 | transition writes b=2 | F1 returns transition token; immediate receipt/walk/setState under it |
| 4 | transition then batch close | no React delivery drain exists; core effects flush newest after close |
| legal variants | transition around `batch`, plain writes in transition, `startSignalTransition` | all writes observe the active transition carrier/token at their own call |

outcome: a's cone gets urgent/default work and b's cone gets transition work.

residual risk: someone reintroducing grouped notification; static/behavioral
test asserts setState happens in each write's dynamic extent.

### C7: handler during a yielded render

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | T pass starts and reads a=0 | frozen pin p, include mask/lock view; may be RENDER_NEWEST initially |
| 2 | F2 slice-exit yield | render frame cleared; retro queue drained before host receives control |
| 3 | click handler reads/writes a | read routes NEWEST; write is legal, logged under click U, and demotes live RENDER_NEWEST bindings to their original frozen worlds |
| 4 | T resumes | F2 restores T frame; its fold uses original pin p, so U receipt/retirement stamped after p is excluded; all T reads agree with step 1 |
| 5 | later pass | a fresh pass may include retired/locked U according to its new pin |

outcome: handler sees newest, write does not throw, resumed pass sees one old
world.

residual risk: callback ordering at yield; fork tests 4-6 and a two-sibling
tear assertion.

### C8: equal newest writes retain receipts

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | T sets a=1 | receipt s1; K0=1 |
| 2 | U sets a=1 | history is nonempty, so receipt s2 is appended even though K0 equality holds |
| 3 | U render | excludes T; applies its own set to base 0 =>1 |
| 4 | T closes/aborts | D2 folds rather than truncates; U receipt alone preserves 1; overlapping-transition variant has one receipt per token |

outcome: U's world contains its write and no retirement can lose the value.

residual risk: equality micro-optimization; forced tests inspect tape length and
all token-subset folds.

### C9: existing and fresh nodes mount mid-transition

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k writes dependencies | receipts and TS bits exist |
| 2 | pass mounts existing computed | touched route selects world memo; K1 tracks actual k-world deps |
| 3 | pass creates fresh hook node | node is staged, K0 cache is uninitialized so freshness rule forces world evaluation on first read |
| 4 | pass commits | F9 publishes fresh node/evaluator only for winning hook, before layout fixup; both rendered k values on first pass |
| error/Offscreen variants | abandoned child emits no F9; hidden committed child does emit | no speculative promotion; reveal can reuse correct evaluator |

outcome: no canonical leak and no corrective first render is required.

residual risk: fresh-node allocator/reclamation; repeated mount-abandon stress
must keep arena high-water bounded.

### C10: late subscription joins a pending token

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k writes a before W subscribes | TS path records k even though no watcher existed |
| 2 | W renders a differing world and subscribes | layout fixup reads TS and live-written registry |
| 3 | k still live | `runInBatch(k,setState)` adds work to k's own lanes; F4 forces another k render even if prior work completed |
| 4 | race: k retired | F3 fold/stamp happened before layout; committed compare differs and urgent pre-paint update fires |

outcome: live case has one k commit containing correction; retired race has the
allowed urgent pre-paint fallback, not a new transition.

residual risk: F3/F4/layout ordering; fork tests 9, 11, 12 plus mount-window
fuzz.

### C11: full multi-root support with watermarked prefixes

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | async T writes a=1 at s1 | carrier T; token parked; both root watcher cones delivered |
| 2 | root A commits T pass p1 | only T in exact include advances `L_A[T]=(p1,stamp1)`; effects A see 1; B has no lock |
| 3 | post-await T writes a=2 at s2>p1 | carrier restores T; A committed world still admits T only through p1; B still excludes |
| 4 | unrelated urgent U on A has pin above s2 | U include omits T, so F3 does not advance T watermark; U fold sees a=1 through old lock plus its own/retired writes |
| 5 | A later renders T | plain include clause admits s2; commit advances watermark by max to p2; A effects see 2 |
| 6 | B commits its T work | B creates its own watermark; cross-root skew was allowed, each root matched its DOM |
| 7 | T settles/retires | retirement stamp precedes removal of both locks; token retires once; passive effects on each root use that root's committed view |

outcome: A never leaks s2 through U, B remains independently consistent, and
retirement is exact once.

residual risk: exact include set and frozen lock views; exhaustive two-root x
two-action x urgent interleaving model test.

### C12: store-only transitions and async actions persist

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | sync store-only transition sets 5 | token/receipt exists without watcher; close produces committed=false retirement, which folds 5 |
| 2 | transformed async action writes 1 | token parked; no subscriber requirement |
| 3 | after await writes 2 | driver restores same token; second receipt remains unretired while park ref lives |
| 4 | unrelated click | no action frame, so its own token; no identity bleed |
| 5 | action settles | last park ref clears; F3 retires; replay yields 2 and effects see it only now |
| explicit opaque variant | uncompiled continuation calls `scope.set(2)` | bound scope supplies same live token; raw set is U1 unsupported |

outcome: writes persist and async action writes do not commit before settlement
within the declared carrier/build contract.

residual risk: transform coverage; manifest/probe plus the explicit U1 support
line are release-blocking documentation/tests.

### C13: counter and world-id lifecycle

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | drive complete quiescence | refresh succeeds or exemptions cone-copy; pins/queues drain; episode increments |
| 2 | reset/recycle | section 12.3 clear/generation rules execute; world keys include new epoch; slots/root/pass/node ids include generations |
| 3 | force small counters to collide numerically | stale memo key fails epoch/gen; stale queue fails slot/watcher gen; stale settle/publication fails node/entry/stage gen |
| 4 | global sequence horizon | quiescent renumber rewrites retained state under epoch bump; never-quiescent case throws before comparison becomes unsafe |

outcome: no retained structure can validate solely from a recycled small
number.

residual risk: omitted column; schema retainer table must generate a reset-site
audit and forced-wrap test for every row in 12.3.

### C14: StrictMode and replay

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | double render | reads may add K1 union edges/memos but run no user effect/write; values remain pass-local |
| 2 | render-phase signal write | first guard throws before receipt, K0, TS, or queue mutation |
| 3 | double mount/unmount | observed lifecycle flap is held through microtask, net one subscription/start |
| 4 | staged evaluator replay | identical deps reuse the pass stage/stamp; changed deps replace it; only winning F9 id promotes |
| 5 | Suspense replay | same lineage/position and unchanged flattened prefix return same thenable |

outcome: replay cannot double-write/publish/effect and cannot suspend forever.

residual risk: observable over-render from retained K1 union edges; count it
against G-N and assert no value/effect semantic difference.

### C15: Suspense across worlds

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | k evaluates c and suspends | capsule `(cGen,Lk,pos)` stores thenable, generation, flattened prefix under wk; memo stores SUSPENSION/backref |
| 2 | component mounts mid-k | same lineage and prefix reuse exact thenable; React `use` suspends on it |
| 3 | intra-k prefix atom write | visible receipt term/slot clock changes; retry prefix mismatches and lazy factory creates a new resource; old settle gen fails |
| 4 | promise settles with no content change | backref kills memo; retry may have new pass pin but same receipt-line prefix, so same settled thenable is reused and c returns value |
| 5 | older receipt becomes visible under newer | retirement stamp or this root's captured slot-lock stamp changes `fp`; stale-world thenable is not reused |
| 6 | root A lock storm, resource on unchanged root B | B's lock view has none of A's stamp; prefix stays stable, so no cross-root starvation |
| 7 | lineage commits/abandons | capsules drop; canonical world never used k's memo/suspension |

outcome: k mounts suspend on stable identity, content changes refetch exactly at
the declared granularity, and k commits settled data.

residual risk: deep flattened-prefix cost; SPK-G8 records length and compares a
coarse per-mask vector only if needed.

### C16: React effects see committed state only

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | default D writes a | K0 newest and tape move; committed root has neither D lock nor retirement |
| 2 | unrelated token retirement flushes effect queue | effect evaluates committed-for-root; visibility excludes D, dependency remains old, callback does not observe D |
| 3 | D commits/retires | root lock/retirement stamps and plain retirement walk enqueue affected effect again |
| 4 | effect flush | committed fold now includes D; value differs, callback runs with it |
| older-under-newer variant | k2 newer receipt visible, then k1 older receipt retires/locks | newly minted visibility term invalidates snapshot even if newest receipt seq is unchanged; replay observes composed value |

outcome: no applied-but-uncommitted value reaches a React effect; core effects
remain documented NEWEST observers.

residual risk: effect queue entry consumed too early; test the unrelated flush
then later D trigger and the older-under-newer arithmetic.

### C17: optimistic rollback

| step | actor/mechanism | state touched |
|---|---|---|
| 1 | API inspection | no truncate/rollback operation exists; React retirement never removes receipts |
| 2 | optimistic product behavior | users express it as later ReducerAtom actions, which are ordinary ordered receipts |

outcome: the conditional case is out of surface rather than incompletely
implemented.

residual risk: accidental internal truncate export; public API/type snapshot
test forbids it.

**Unwalked acceptance cases: none.** U1 is outside the declared build contract;
both supported C12 compositions are walked above.

## 16. Test and delivery plan

Implementation order is oracle-first:

1. Build a reference receipt interpreter over plain objects. Randomize writes,
   token subsets, pins, root lock prefixes, retirement order, custom equality,
   and reducer operations. Compare every atom/world fold.
2. Freeze K0's contract: 179/179 conformance, exact pull counts, growth stress,
   and bytecode/symbol budgets before LOGGED machinery lands.
3. Implement F1-F7 and tapes; run C2/C3/C7/C11/C12 differentials before K1.
4. Add K1, touched propagation, retro queue generations, and brute-force reach
   oracle. Fuzz all orderings of receipt, edge, watcher, render re-arm,
   retirement, and slot reuse.
5. Add world memos and mutate each validity-table source independently. The
   generated schema must fail CI when a retained field lacks a clear/guard row.
6. Add F9 staging tests before hooks use staged evaluators: error boundary,
   hidden Offscreen, reveal without render, stale alternate, same-pass restart,
   StrictMode, and abandoned fresh-node reclamation.
7. Add lineage capsules and deterministic lazy factories; test nested flattened
   prefixes, old settlement, visibility flips, cross-root lock storms, and
   unrelated retirement.
8. Add F8/build transform and its 74-case carrier class plus this artifact's
   manifest, re-entrancy, realm, explicit-scope, and negative U1 fixtures.
9. Run the react-concurrent-store 14-scenario harness, including its formerly
   known mount-mid-transition suspension bug, then C1-C17 side-by-side with
   `useState`/`useReducer` at every intermediate commit.
10. Run W1/W2/W3/W5 and all numeric gates one framework per process on an idle
    machine. Store raw samples, heapUsed, plane bytes, and environment; a noisy
    run is not a baseline.

Model-checking batteries use forced two-bit slot generations, three-bit token
serials, two-bit K1 tags, tiny global-sequence horizons, two roots, and up to
five live tokens. The visibility oracle specifically permutes initial lock,
watermark advance, unrelated-root lock, out-of-order retirement, lock clear,
and pin-held compaction.

The fork suite from section 14 runs on every React rebase. The transform suite
runs against every supported bundler target. Type tests pin the overloads for
lazy/eager `ctx.use`, ActionScope realm/lifetime errors, and absence of a
truncate API.

## 17. Tracing and operational diagnostics

Each instrumented site reads one recorder slot. Zero means return immediately
with no allocation. An enabled recorder writes fixed integer records to either
a preallocated lossy ring or an explicitly started lossless segmented session.
Event kinds cover receipt append/fold, token/slot generation, pass/slice,
world-route decision, memo hit/miss reason, K1 edge/bit propagation,
retro enqueue/drain/fallback, watcher delivery/re-arm, root watermark/stamp,
F9 stage/publication rejection, resource reuse/replacement/settle, carrier
push/pop/park, refresh strike/exemption/cone copy, and counter renumber/throw.

Causality queries join integer ids offline: "which receipt scheduled this
watcher", "why did this world memo miss", "which lock event changed this
prefix", and "why was this action token still parked". Graphviz renderers show
K0, K1, TS bits, and receipt paths. Labels live in cold side tables and are read
only by the renderer. Lossless mode refuses to start without a caller-supplied
capacity policy; it never silently becomes lossy.

Development diagnostics include:

- build/carrier ABI mismatch and unsupported raw boundary guidance;
- root/token/slot/generation in stale retro or publication rejection;
- global-sequence horizon with the live retainer preventing quiescence;
- refresh targets that become exempt and the size of their carried cone;
- reducer swap with pending receipts;
- second-root registration information (supported, not rejected);
- stock React protocol absence.

## 18. Engineering constraints and packaging

Packages are pnpm workspaces written in TypeScript. Public shapes use `type`,
branded integer ids, and `undefined` rather than `null`. Any necessary `null`
is isolated at a React/host API that requires it and commented. `__DEV__` is a
build define. Same-file nonexported const enums encode records; cross-file enum
inlining is not assumed. No generic `isRecord` helper is introduced.

Schema/codegen is the single source for plane offsets, const enums, debug twin
hydrators, lifecycle tables, invariant sweeps, and bytecode budgets. Generated
output is regenerate-and-diff checked. Hot collection construction uses direct
loops and mutation, not allocation-heavy combinators. Growth and free-list work
happen at operation boundaries. Benchmarks publish V8 and JSC rankings
separately.

`cosignal/core` ships DIRECT by default. `cosignal/react` registers the bridge
and selects LOGGED monotonically. The carrier transform is a versioned bundler
plugin with a manifest; the runtime package exports its ABI probe. SSR can use
DIRECT or LOGGED with no live tokens, but hydration must restore serialized
bases before React render.

## 19. Rejected variants and known gaps

Rejected by a concrete schedule or measured fact:

- urgent no-log writes (C2/C3);
- world state in K0's per-link hot walks (measured hot-path pollution);
- canonical-only pending dependencies (C1);
- once-per-staleness or shared frontier delivery (C4 and cross-slot overwrite);
- value/equality delivery suppression (finished-but-uncommitted stale tree);
- pinless world memos as the default (cross-pass `previous` and episode reuse);
- root-global lock visibility stamps (B1);
- hook-effect or pass-grain evaluator publication (B2/error boundary);
- direct-only exemption edge carry (B3);
- full-token root lock-in (post-await leak);
- global retirement clocks in resource identity (unrelated starvation);
- Promise patching or returned-thenable wrapping as an await carrier (U1/S22);
- ambient cross-realm/worker token import;
- optimistic receipt truncation.

Known gaps, stated without converting them into claims:

1. **U1:** arbitrary raw signal writes in opaque uncompiled post-await code are
   unsupported and not fully discoverable by a boot probe. Transform it or use
   ActionScope.
2. **SPK-L/G-Q:** LOGGED-quiet's measured branch floor is above the current 2%
   target; an idle-machine gate/requirements decision remains.
3. **W1/SPK-N1:** value-blind full reach under a long-held, repeatedly rendered
   batch may miss the propagation budget. There is no approved correctness-safe
   traversal prune.
4. **W2/G-F:** ten-token mass mount may miss P1 even though its correction bound
   is exact. Vectorized seam and reconciler-native remaining-lane updates are
   alternatives to measure, not current mechanisms.
5. **W3/SPK-G8:** exact-pin restart revalidation and flattened-prefix length are
   unmeasured. The content-frontier hybrid remains a candidate only.
6. **SPK-R/W5:** corrected retirement/effect comparator needs measurements.
7. **Fork existence proof:** F2/F3/F4/F9's current-generation React anchors and
   their 21 tests are on the critical path. A design protocol is not evidence
   that the fork patch already exists.
8. **SP2:** E-PRESERVE development validator cost is unmeasured; above 10%, use
   deterministic sampling while keeping exhaustive CI fuzz.
9. **K1 over-delivery:** discarded/world-divergent edges remain until reset and
   can cause extra React renders. G-N measures them; values/effects stay guarded.
10. **Cone retention:** a permanently writing computed can retain its reverse
    K1 cone across episodes. The cone is finite and traced, but its real
    workloads are unmeasured.

None of these hides an unwalked C1-C17 result. Numeric gates remain open until
measured, and U1 is a declared build-contract boundary with a supported explicit
composition.

## 20. Delta tally

- Architecture class: unchanged two-kernel champion.
- Confirmed round-3 breaks: 4; B1-B3 repaired in mechanisms 3/4/6/8/10, B4
  repaired in the performance contract.
- Unarmorable ambient boundary: 1 (U1), with transformed and explicit-scope
  supported paths.
- Verified-held priority attacks: 10 entries in section 2.3.
- Mechanisms: **10**.
- Seam touch-points: **9 facts (F1-F9), approximately 16 fork/runtime sites**.
- Acceptance battery: **C1-C17 all walked; no unwalked case**.
