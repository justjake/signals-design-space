# Review: FORK-NATIVE is not commit-safe

## Findings

### 1. A pass world changes when another token retires

**BLOCKER — architectural**

Construction A constrains cache lifetime, but does not pin the inputs of future folds within a pass. M1 makes every fully retired operation visible to every mask immediately.

Schedule:

1. Transition pass P mounts two previously unmounted siblings over atoms `x=0, y=0`; neither has a committed watcher yet.
2. The first sibling reads `x`; `memo(P)[x]=0`. React yields before rendering the second sibling.
3. A handler batch U writes `x=1` and `y=1`. M8 finds no mounted watchers, so U has no React work.
4. M2 closes and retires U. M1 advances the queues or, equivalently, makes both U operations visible through `fullyRetired(U)`.
5. U is not in P’s mask, so PF-3 does not restart P.
6. P resumes. The second sibling’s first read of `y` calls `fold(y,P.mask)`, which now includes retired U and returns `1`; the first sibling remains rendered with `x=0`.
7. The pre-commit gate has no subscribed watchers for this newly mounting subtree, so P commits `{x=0,y=1}`.

That frame is neither P’s original world nor its correctly rebased world. Fixing it requires a retirement frontier pinned at pass start, preserved old queue state, or restarting every affected pass before retirement changes become readable; the current token mask and append-only memo are insufficient.

### 2. A live default-priority pass poisons the canonical graph before commit

**BLOCKER — architectural**

“Committed-class” is defined as containing no live **deferred** token, and C1-T4 explicitly re-tracks canonical edges during an urgent-class pass. Default-priority D is urgent-classified but asynchronous and excludable, so Construction A’s claim about every live-token mask is proved only for live-deferred masks.

Setup: `flag=false, a=0, b=0`, `c=flag?a:b`, canonical edges `{flag,b}`, and W displays `0`.

Schedule:

1. Default batch D writes `flag=true`. W gets `setState@D`, but no deferred token is live, so the stale-window rule does not add a gate entry.
2. D begins rendering asynchronously. Its pass evaluates `c=0` through `a` and, as a “committed-class” evaluation, replaces the canonical edges with `{flag,a}` and writes the durable canonical cache.
3. D yields before commit.
4. A `flushSync` batch U writes `b=1` and updates an unrelated sibling. The canonical walk from `b` no longer reaches W.
5. The Sync pass excludes D. W has only D-lane work and is not rendered.
6. `gateSet` is empty, there is no live deferred token, and no skew window is open, so M5 fast-outs.
7. U commits. Its correct world has `flag=false, b=1`, hence `c=1`, but W still displays `0`.

Every uncommitted pass, including default-priority passes, must keep its values and topology transient until commit. That changes M7, M9, the gate conditions, and both constructions.

### 3. One canonical computed cache cannot represent per-root committed worlds

**BLOCKER — architectural**

M6 makes atom committed views per-root, but M7 retains one durable canonical cache and one clean/stale state per computed.

Schedule:

1. Roots A and B share atom `flag=false` and computed `c=flag`.
2. Spanning transition k writes `flag=true`.
3. A commits k while B remains pending. Thus `committedView(flag,A)=true` and `committedView(flag,B)=false`.
4. A’s `useSignalEffect` evaluates c, stores `true` in c’s canonical cache, and clears c’s global stale state.
5. An unrelated update on B mounts or reruns a `useSignalEffect` that reads c before B commits k.
6. The skew gate is tagged with k and is not selected by the unrelated commit. The effect’s committed-class read sees c’s clean canonical cache and returns `true` without reading B’s atom view.
7. B’s effect observes `true`, although B’s committed world requires `false`.

Per-root atom folds do not make transitive computed caches per-root. Full spanning support needs per-root computed validity/value state or fresh root-scoped evaluation; either is a material architectural addition.

### 4. `gateSet` does not cover tokens written after a stale window opens

**BLOCKER — local fix**

Construction B claims later tokens see fresh edges, but a later token can write before those edges become fresh.

Schedule:

1. From the standard C1 setup, T1 writes `flag=true`. M8 schedules W and adds `gateSet(c,{T1})`.
2. Before T1 renders, distinct transition T2 writes `a=1` and schedules unrelated suspending React work. Since `a` is absent from `{flag,b}`, T2 neither notifies W nor adds T2 to c’s gate tag.
3. React commits T1 alone while T2 remains suspended. W renders `c=0` because T2 is excluded.
4. T1’s gate sweep validates `0`, clears the T1 bit, and commit-time adoption changes c’s canonical edges to `{flag,a}`.
5. Nothing replays T2’s earlier write through the newly adopted edge.
6. T2 later completes. W has no T2-lane update, and c’s gate entry has died, so T2 commits without rendering W.
7. The committed state is `flag=true, a=1`, but W still displays `0`.

A gate entry must cover writes occurring throughout the entire topology-stale interval, including tokens minted later. A wildcard/open-window epoch or write-clock validation at adoption can repair this locally, but §7.2 and Construction B must be rewritten.

### 5. Core effects can permanently miss a divergent-dependency write

**BLOCKER — architectural**

The gate protects subscribed React watchers only. Core effects still require the canonical graph to deliver every relevant write.

Schedule:

1. A core effect depends on `c=flag?a:b`; initially `flag=false`, so c’s edges are `{flag,b}` and the effect has observed `0`.
2. T1 writes `flag=true`, marking c/effect for retirement-time verification.
3. Before T1 retires, distinct live T2 writes `a=1`. The canonical walk misses c because `a` is not yet an edge.
4. T1 retires first. Fully-retired evaluation sees `flag=true` but excludes live T2, so c remains `0`; it re-tracks to `{flag,a}` and equality cutoff clears the downstream effect work.
5. T2 later retires. Its write-time walk already happened, and no M1–M13 mechanism replays T2’s touched atoms against the new edges at retirement.
6. The fully retired value of c is now `1`, but the effect remains at `0`.

This repeats scar S3 outside the screen gate. Correct core effects require retirement receipts/replay, complete dependency knowledge, or unconditional retirement validation—not merely a watcher commit gate.

### 6. Completed-pass read sets are destroyed before commit-time adoption

**BLOCKER — local fix**

C-3 drops the per-pass memo at `onPassEnd`, while §7.3 later consumes that memo at `onCommit`.

Schedule:

1. Transition k mounts M with fresh `useComputed(() => a.state)`. Its first evaluation correctly records `{a}` only in P’s transient memo; deferred evaluation creates no canonical edge.
2. P completes. C-3 fires from the work-loop exit and Construction A requires `memo(P)` to be discarded.
3. The pre-commit gate runs before M’s subscription effect, so it has no mounted watcher to adopt or validate.
4. C-5 reaches §7.3 and attempts commit-time adoption, but P’s captured read set no longer exists.
5. M subscribes during the effect phase. Its fixup may tag k, but it cannot recover the discarded read set; after k retires, that token tag is cleared.
6. A later urgent batch writes `a=1`. The canonical graph has no `a→fresh-node→W` path, so W is not scheduled and the empty gate does not correct it.
7. M remains rendered with `0`.

Completed memos must survive until commit or definitive discard, with separate lifecycle edges for yield, completion, supersession, and commit.

### 7. Render-phase writes mutate state before they throw

**BLOCKER — local fix**

S4 appends the operation before `onWrite`; §5.2 updates the hot slot and clock before checking `getRenderContext()` and throwing.

Schedule:

1. `a=0`; a component calls `a.update(x=>x+1)` during render.
2. S4 classifies the write and appends the updater to the SharedQueue.
3. `onWrite` applies it to the hot slot (`a=1`) and increments the slot clock.
4. Only then does the render-context check throw.
5. React discards the render or commits an error boundary, but an event-handler read now observes `a.state===1`; eventual retirement also folds the supposedly rejected operation.
6. If React retries the component, another updater can be appended, producing `2`.

The render check must occur before classification has any externally retained effect—preferably in fork dispatch before append, with a library-side precheck only as an optimization.

### 8. Counter wraparound is tested but not made safe

**BLOCKER — local fix**

The statement that the 32-bit token serial is “never reused while live” has no allocator construction. A forced-wrap test is not a reuse guard.

Schedule with a forced two-bit serial:

1. Park transition K with token `0` and operation `a.set(10)`.
2. Mint and retire tokens `1`, `2`, and `3` while K remains live.
3. The serial wraps. A new urgent batch U must either reuse `0` or encounter an unspecified exhaustion path.
4. If U receives `0` and performs `a.update(x=>x+1)`, U’s mask `{0}` also selects K’s operation.
5. U renders `11`; correct React queue semantics excluding K require `1`.

The allocator must skip live identities or carry an epoch, and exhaustion behavior must be specified. The same missing construction exists for `slotGen` wrapping while watcher clock records remain retained and for sequence ordering across wrap; “forced-wrap test” does not define why either remains safe.

## Verified held

- C3’s queue arithmetic held: prefix freezing and write-order replay produce urgent `2`, deferred `4`, and the plain-set variant `5`.
- The direct C1 same-token schedule held under PF-2/PF-3: the flag write schedules W, and the later divergent write forces a fresh pass.
- C4’s per-watcher, per-token dedup schedules both T1 and T2 when both writes traverse canonical topology.
- C6’s lane attribution held because notification is synchronous in each writer’s execution context rather than drained later.
- C8’s receipt rule held: a nonempty queue forces equal writes to append, so overlapping worlds remain reconstructible.
- C10’s correction joins the existing batch under the stated PF-7 `runInBatch` invariant; a fresh transition would not be equivalent.
- C12’s store-only persistence held under the stated exactly-once retirement and async-parking invariants.
- C17 is genuinely absent because no truncation API is exposed.
- PF-1’s per-callstack render detection correctly classifies yield-gap handler reads and writes; the failure is subsequent value pinning, not context detection.
- The seam itself isolates lane names, commit-site movement, and hook-queue refactors from library code, assuming the protocol facts are sufficient.

## Verdict

The design is architecturally unsound. The SharedQueue/pass model lacks a pinned visibility frontier, while one canonical cache and graph cannot simultaneously represent asynchronous default passes, multiple root-committed worlds, and core-effect delivery. Local repairs can address mutation-before-throw, memo lifetime, gate-tag closure, and counter reuse, but the value-snapshot and committed-world architecture requires redesign before implementation.