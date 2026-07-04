# Correctness review: `react-concurrent-signals-arena.md`

The design is not implementation-ready. I found five correctness blockers and two additional gaps. The packed canonical layout can remain intact, but world-specific notification needs a real mechanism outside that layout.

## Findings

### 1. Blocker — speculative dependencies cannot notify their watchers

Overlay evaluation deliberately does not add graph edges (`react-concurrent-signals-arena.md:1488`), while `notifyWalk` traverses only canonical subscriber edges (`react-concurrent-signals-arena.md:1077`).

The document's own T1 cannot work:

- Canonical `c = flag ? a : b` links `flag,b`.
- Batch `k` changes `flag`, so overlay evaluation reads `a`, untracked.
- A later `a=1` walk has no `a -> c` edge, so it cannot reach `c` or its watcher.
- Memo invalidation could make a subsequent read correct, but nothing schedules that read.

This directly contradicts the asserted notification at `react-concurrent-signals-arena.md:2573`.

It also gets worse for urgent writes: evaluating only the writer's world (`react-concurrent-signals-arena.md:1593`) misses an urgent write that changes a pending batch's world but not the committed/urgent world.

Holistic options:

- Correctness-first baseline: keep a packed side vector of active watcher IDs and scan it on logged drains. Deferred writes compare the writing batch; urgent writes must also invalidate/check live deferred worlds.
- Optimized design: add a separate, ephemeral overlay-dependency plane keyed by source and world, with lifetime tied to world memos and bulk reset at quiescence.

I would establish the global-scan oracle implementation first, then introduce the overlay plane only if benchmarks require it. Do not add fields to `M`.

### 2. Blocker — the memo validity certificate omits exactly the dependency in T1

`srcAtoms` records only atoms already carrying `LOGGED` (`react-concurrent-signals-arena.md:1513`). In T1, `a` is unlogged when the pending world first reads it. Therefore `a` is absent from the memo. Its first subsequent write cannot fail any recorded tail check, contrary to `react-concurrent-signals-arena.md:2575`.

Nested memo hits have a similar hole unless a child memo's dependency certificate is merged into its parent. Promise settlement also changes a result without moving an atom tail.

Two viable approaches:

- Simple correctness baseline: increment the existing `overlayEpoch` on every append and relevant promise settlement. This is conservative but requires no new packed data.
- Precise optimization: certificates include every observed atom, using sequence `0` for currently-unlogged atoms, and parent evaluations inherit certificates from child memo hits. Promise/computed dependencies need equivalent validation.

### 3. Blocker — logging starts too late for mount-during-transition correctness

`writeMode` remains `DIRECT` until the first watcher mounts (`react-concurrent-signals-arena.md:1133`). Consider:

```ts
startTransition(() => {
  atom.set(1)       // no watcher yet, so DIRECT
  setShow(true)     // transition mounts the first useSignal(atom)
})
```

The transition write has already overwritten canonical state without a receipt. Any urgent render before the transition commits also sees `1`; the transition cannot be excluded. This defeats the mount-during-transition guarantee claimed at `react-concurrent-signals-arena.md:1884`.

The safe gate is monotonic bridge activation: pure-core users remain `DIRECT`, but importing/activating `cosignal/react` switches writes to `LOGGED`, independent of mounted watcher count. It cannot safely switch back based on current subscriptions.

### 4. Blocker — equality cannot discard logged actions

The design drops a write by comparing against `NEWEST` before appending (`react-concurrent-signals-arena.md:499`, `react-concurrent-signals-arena.md:1690`).

Counterexample:

- Committed/base value is `0`.
- Pending transition T writes `SET 1`.
- Urgent U writes `SET 1`.
- `NEWEST` is already `1`, so U is dropped.
- U's render excludes T and incorrectly reads `0`.

Dropping `UPDATE` or `DISPATCH` is even less sound: an operation equal against today's accumulator can become non-equal after an older excluded batch retires ahead of it.

In `LOGGED` mode, every logical operation must produce a receipt. Equality belongs inside each world's fold:

```ts
next = applyOperation(acc)
acc = isEqual(acc, next) ? acc : next
```

It may suppress kernel propagation and watcher scheduling, but not action history. Same-batch function composition must preserve these intermediate equality gates. `DIRECT` mode can still drop equal writes.

### 5. Blocker — a first urgent log never marks its computed cone

`appendLog` explicitly does not notify or mark (`react-concurrent-signals-arena.md:1205`); only deferred writes run `notifyWalk` (`react-concurrent-signals-arena.md:1351`). Yet the urgent path claims "the tape-creating write marked it" (`react-concurrent-signals-arena.md:1383`). No specified operation does that.

Consequently, after the first urgent logged write, an excluding render of a downstream computed takes the unmarked kernel path and sees the applied urgent value.

On `LOG_HEAD: 0 -> nonzero`, every write classification needs a mark-only cone walk. This can reuse the existing walk ticket and `OVERLAY_STAMP`; no record field is needed. Urgent kernel propagation remains responsible for ordinary watcher collection.

### 6. High — `COMMITTED` is global, but commits are per root

A token retires only after its last root finishes (`react-concurrent-signals-arena.md:655`). Meanwhile `COMMITTED` includes only retired entries (`react-concurrent-signals-arena.md:1425`), and `useSignalEffect` runs in that context after each root's commit (`react-concurrent-signals-arena.md:1941`).

If root A commits a spanning batch while root B remains pending, root A's passive effect reads the old value and does not rerun correctly until B finishes.

The fork/bindings need a root-specific committed view: committed pass pin plus included/locked-in batches. Store that in a root table in the React layer, not in node records.

### 7. High — the Suspense cache has no defined key for a multi-batch pass

World memos identify pass worlds by `passSerial`, but the thenable cache says a pass world is keyed by "the batch token" (`react-concurrent-signals-arena.md:1806`). A render pass may include multiple tokens, explicitly tested by T7. There is no singular token to use, and keying by one can alias distinct worlds.

This needs an explicit render-lineage/cache identity from the fork or a full root/view key with defined reuse across Suspense retries. It belongs in side metadata, not the packed graph.

## Recommended architectural revision

Keep `M` at stride 8 and `G` at stride 4. Integrate the corrections around them:

- Activate logging based on React-bridge availability, not watcher count.
- Log every operation; apply equality during replay and notification.
- Mark the cone whenever an atom first becomes logged, urgent or deferred.
- Initially invalidate world memos with a conservative append epoch.
- Use a packed watcher vector as the correctness baseline.
- If scanning is too expensive, introduce a third, quiescence-reset overlay-dependency plane rather than expanding every canonical node.
- Add root-specific committed-view state in the bindings.
- Define a real Suspense render-lineage key.

One edge case needs an explicit product decision before implementation: may `update(fn)` or a reducer read other signals? If yes, per-atom replay and the claim that composition is always sound (`react-concurrent-signals-arena.md:1214`) need a global ordering model. If no, document that operations may depend only on their arguments and immutable captures.

No repository files other than this review were changed as part of the review.
