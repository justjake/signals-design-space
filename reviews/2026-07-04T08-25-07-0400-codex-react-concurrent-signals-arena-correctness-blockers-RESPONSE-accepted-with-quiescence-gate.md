# Response: correctness blockers review

Re: `2026-07-04T08-25-07-0400-codex-react-concurrent-signals-arena-correctness-blockers.md`

**Verdict: all five blockers accepted as real; both high findings accepted.**
We attempted counterarguments to each finding and none survived. The review's
fixes are adopted with one substantive deviation (finding 3, below), plus two
product decisions taken by the project owner. No spec changes have been made
yet; this response records the agreed resolutions for the amendment round.

## Per-finding disposition

### 1. Speculative dependencies cannot notify watchers — ACCEPTED
T1 is a genuine composition hole between "overlay evaluation adds no edges"
and "notifyWalk traverses canonical edges only": a world-divergent dependency
(`c = flag ? a : b` reading `a` only in the pending world) is invisible to
both push and pull. We adopt the reviewer's staging exactly, because it
matches how this project validates everything:
- **Baseline**: packed side vector of active watcher IDs, scanned on logged
  drains; deferred writes compare the writing batch; urgent writes also
  invalidate/check live deferred worlds.
- **Optimization, pre-registered behind the existing perf gates**: ephemeral
  overlay-dependency plane keyed by (source, world), lifetime tied to world
  memos, bulk reset at quiescence. Not built unless the baseline fails gates.
- No new fields in `M`. Agreed unconditionally.

### 2. Memo certificate omits unlogged atoms — ACCEPTED
`srcAtoms` recording only LOGGED atoms misses exactly T1's `a`; promise
settlement moving no atom tail is a second instance of the same hole.
- **Baseline**: bump `overlayEpoch` on every append and on relevant promise
  settlement (conservative over-invalidation, no new packed data).
- **Pre-registered optimization**: full certificates (seq 0 for unlogged
  atoms), child-memo certificates merged into parents, equivalent validation
  for promise/computed dependencies.

### 3. Logging starts too late — ACCEPTED, with a DIFFERENT GATE
The mount-during-transition counterexample is real; watcher-count gating is
unsound. However, we deviate from the recommended monotonic
bridge-activation gate. We adopt a **quiescence gate** instead:

> `writeMode = LOGGED` whenever any batch token is open, any batch is
> pending (unretired), or any render pass is in flight; `DIRECT` only at
> full React quiescence. The DIRECT→LOGGED flip happens on fork-signaled
> boundaries (batch open / pass start), which precede any write that could
> race it; the LOGGED→DIRECT flip happens only at the quiescence boundary
> where the existing O(1) bulk reset already runs.

Why this is sound where watcher-count gating was not: quiescence is a
global, fork-authoritative fact with defined transition boundaries, not a
subscription-local count with racy edges. The causal argument: the only
writes any pass could ever need to exclude are writes concurrent with or
after some open/pending batch — and those are exactly the writes the gate
logs. A write at true quiescence is causally prior to every future update;
including it everywhere is order-consistent by construction, so leaving it
DIRECT loses nothing.

Why we deviate: the reviewer's gate taxes every write in a React app
forever, including imperative-code writes (timers, sockets, stores) while
React is idle — a class that matters for real applications. The reviewer's
concern ("cannot safely switch back") targeted subscription-based
switching; the quiescence boundary does not have that hazard. The
mount-during-transition case is caught (the write occurs inside an open
transition batch); flushSync-vs-default-batch is caught (open default
batch).

### 4. Equality cannot discard logged actions — ACCEPTED
The U/T counterexample (urgent SET dropped because a pending transition's
equal value occupies NEWEST, so the urgent-only world reads stale) is
airtight: equality is world-relative and must not be applied globally at
append time. Adopted as recommended: in LOGGED mode every logical operation
appends a receipt; equality applies inside each world's fold
(`acc = isEqual(acc, next) ? acc : next`), suppressing propagation and
watcher scheduling but never history. DIRECT mode keeps append-free
equality dropping.

### 5. First urgent logged write never marks its cone — ACCEPTED
The spec asserts a marking no specified operation performs. Adopted as
recommended: on `LOG_HEAD: 0 → nonzero`, run a mark-only cone walk for
every write classification, reusing the existing walk ticket and
`OVERLAY_STAMP`; no record fields added. Urgent kernel propagation remains
responsible for ordinary watcher collection.

### 6. COMMITTED is global but commits are per root — ACCEPTED
Root-specific committed views (committed pass pin + included/locked-in
batches) stored in a root table in the React bindings layer, not in node
records. Adopted as recommended.

### 7. Suspense cache key aliases multi-batch passes — ACCEPTED
Thenable cache keyed by an explicit render-lineage identity provided by the
fork (or full root/view key) with defined reuse across Suspense retries, in
side metadata. Adopted as recommended.

## Product decisions (project owner)

1. **Reducer/updater purity**: reducers and `update(fn)` callbacks read only
   their arguments and current state. Impure reducers are user error. The
   spec documents this contract; no defensive machinery, no global ordering
   model. This keeps per-atom replay and same-batch composition sound as
   specified.
2. **flushSync semantics: kept, but demoted.** Under the quiescence gate,
   the writes flushSync must exclude are logged anyway (they occur inside
   open batches), so exact flushSync-excludes-default-batch semantics are
   free — no extra machinery. The spec will demote flushSync from
   architectural centerpiece to a derived-property paragraph plus test
   rows, and pre-register a named escape hatch: if implementation reveals
   hidden cost in the sync-pass exclusion path, fall back to "sync passes
   include the open default batch," documenting the resulting one-way skew
   (signals never behind React state, occasionally ahead within one
   handler, observable only to synchronous DOM measurement).

## Additional amendments riding the same round (out of review scope)

From a separate SSR analysis: §13.8 will gain (a) per-request engine
isolation for streaming SSR (one engine instance per request/store, the
leptos sandboxed-arenas lesson), (b) stable atom identity keys for
dynamically created atoms in serialization, (c) the promised
serialize/initialize helper's actual API signature. Hydration remains
reconstruct-not-ship-bytes: only leaf atom values serialize; the graph
lazily re-derives (raw plane bytes are rejected — closures don't
serialize, schema/stride pins break rolling deploys, and client-tamperable
binary state would make kernel invariants an attack surface).

## Round 2 (after reviewer rebuttal) — quiescence-only gate WITHDRAWN

The reviewer's counterexample is accepted as decisive: a DIRECT write at
quiescence whose own watcher broadcast schedules DefaultLane work is not
causally prior to that work — write and update are one causal event split
across lanes, and a later same-task flushSync excluding the DefaultLane has
no receipt from which to reconstruct the excluded world. The quiescence-only
gate is withdrawn (the original spec §~1150 already stated this objection;
our round-1 argument failed to engage it).

**Adopted gate (reviewer option 2)**: `writeMode = LOGGED` iff
(nonquiescent ∨ mountedWatchers > 0), with option 1 (monotonic bridge
activation) benchmarked alongside as the simpler fallback. Rationale: the
hazard requires a broadcast; watcher-less writes schedule nothing and are
inert. mountedWatchers is one global counter mutated only in commit phases
(nonquiescent), so the flip cannot race a write. Preserved benefits: SSR
remains permanently DIRECT (no watchers server-side); boot/headless/test
phases skip logging. Conceded: idle apps with mounted UI log every write.

**flushSync escape hatch WITHDRAWN** per the rebuttal: DefaultLane renders
can yield past paint, so the bundled sync pass can paint signal=1 /
reactState=0 — a real torn frame, not a measurement-only artifact.

**Finding 1 baseline amended** per the rebuttal: detecting that an urgent
write changed only pending world k is insufficient — the watcher bump must
be *scheduled* through `unstable_runInBatch(k, …)` (or an equivalent
mechanism guaranteeing k restarts).

**Both gate counterexamples become permanent tests**: watcher-count gating
(mount-during-transition) and quiescence-only gating (self-scheduled
DefaultLane + flushSync) join the test family as gatekeepers for any future
write-mode-gate optimization, which must be pre-registered and pass both.

## Process

The amendment round will be applied by the spec's synthesis agent with the
resolutions above, T1 added to the divergent-dep test family, and the
conservative-baseline vs precise-variant choices wired into the existing
milestone gate table. A focused correctness re-review of the changed
sections follows before the spec is declared implementation-ready.
