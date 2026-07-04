# Acceptance battery: the correctness cases (frozen seed)

Rules of engagement:

- A design must **walk every case**: name the mechanisms that fire, in order,
  and show the values/marks/edges at each step. A table or trace, not prose
  assurance.
- Any "immune / correct **by construction**" claim must include the
  construction — the induction or invariant, written out. Unaccompanied
  by-construction claims are an automatic reviewer blocker. (This rule exists
  because the previous judgment accepted exactly such a claim and it was
  false.)
- Reviewers attack these cases first; judges re-walk them last. A case that
  cannot be walked in a design is a blocker, not a TODO.
- **Restricting the interface is a legitimate design move.** A design may
  resolve a case by *forbidding the pattern at runtime* (a thrown error with
  a clear message) when the pattern is avoidable user code — but it must
  then (a) show the forbidden pattern is reliably *detectable* at the point
  of rejection, (b) define which nearby compositions remain legal, and walk
  those, and (c) never forbid ordinary React behavior the user doesn't
  control (flushSync in an event, time-slicing yields, StrictMode replays,
  a component mounting mid-transition — those must be handled, not banned).

Notation: `T`,`k` = deferred (transition-like) batches; `U` = urgent batch;
`D` = default-priority batch (urgent-classified, but renders asynchronously —
it can be *excluded* from a sync render). "World of X" = the state a render
for X must observe. All cases assume React-mode (bindings active).

---

## C1 — World-divergent dependency (the killer; family of 7)

Setup: atoms `flag=false, a=0, b=0`; computed `c = flag ? a : b`; component W
subscribed to `c`; canonical deps of `c` = {flag, b}.

Schedule: deferred batch k: `flag.set(true)` → (k-world read of `c` may
happen here, caching 0 via `a`) → same batch k: `a.set(1)`.

Required: the k-world value of `c` becomes 1 (any k-world cache invalidated);
W is re-rendered **in k's lane before k commits** (no torn commit where
siblings show k's world and W shows stale); committed world still reads 0
via `b`.

The trap: `a` has **no canonical edge** to `c`. Any invalidation or
notification derived only from canonical topology cannot reach `c`/W. Any
cache-validity record that only captured "atoms with concurrency state at
evaluation time" misses `a` (it acquires state *after* the evaluation).

Variants that must also be walked: T2 write to committed-only dep `b` in k
(no k-world change; over-invalidation ok, wrong value not); T3 shared dep
flips back (`flag=false` in k); T4 urgent write to `b` (committed changes,
k-world doesn't); T5 urgent write to `a` (k-world sees it — pending worlds
include applied urgent state); T6 slot/world-id reuse hygiene after k
retires; T7 two live batches render together, one suspends, one commits
alone (multi-batch and single-batch views over the same nodes).

## C2 — flushSync excludes a pending default batch (forces always-log)

Setup: atom `a=0`, computed `c = a + 10`, components on both.

Schedule: in one event: `a.set(1)` lands in default-priority batch D
(urgent-classified, applied to canonical state if the design applies urgent
writes); then `flushSync(setState)` renders **SyncLane only** — D excluded.

Required: the flushSync render reads `a=0` AND `c=10`. Both. A design whose
canonical value moved and whose downstream computed can be served from a
canonical cache shows `c=11` next to `a=0` — torn frame.

The trap: (a) skipping history for urgent writes makes the older world
unreconstructible (this case is the proof that **every** write needs a
receipt in React mode); (b) recording the receipt but not marking/knowing
the *downstream cone* is world-sensitive leaves `c` on the canonical fast
path.

## C3 — Rebase parity (React's updater-queue arithmetic)

Setup: `a=1`. Deferred T: `a.update(x=>x+1)`; then urgent U:
`a.update(x=>x*2)`.

Required, in order: urgent render (excludes T) shows 2; U commits (fold is a
no-op vs canonical); T's render shows 4 (`(1+1)*2` — replay in write order);
T commits → committed value 4. `useReducer` side-by-side test must match at
every step. A design that applies-and-discards the urgent updater folds T to
2 or 3 — wrong. A plain `set 5` after a pending `+1` must commit 5 (not 6).

## C4 — Two-batch write into an already-stale region (re-notify)

Setup: component W on computed `c` over atom `a`.

Schedule: T1 writes `a` (W notified, re-render scheduled in T1's lane); before
any re-render/commit, a *different* deferred batch T2 writes `a`.

Required: W is also scheduled in **T2's lane** (T2's render includes W). The
trap: once-per-staleness notification dedup (marks that stop walks; an ARMED
bit that re-arms only after the watcher re-runs) has no path from the second
write to W in T2's lane.

## C5 — Cutoff-suppressed first write, effective second write (same batch)

Setup: `c` reads `a` but its value doesn't change when `a` goes 0→1 (e.g.
`c = a*0 + b`); watcher on `c`.

Schedule: batch k writes `a=1` (broadcast correctly suppressed — value equal);
then k writes `b=7`.

Required: the second write reaches the watcher (setState in k's lane) even
though the region is already marked/stale and the first broadcast was
suppressed. Cache-validity must not serve the first evaluation's value.

## C6 — Lane attribution under grouped notification

Schedule: `batch(() => { a.set(1); startTransition(() => b.set(2)) })` — the
engine-level batch closes *after* the transition scope ends.

Required — one of two resolutions, stated explicitly:

- **Handle it**: watcher setStates for `b`'s cone are assigned to the
  transition's lanes (its render includes them; one commit carries them);
  `a`'s cone gets urgent scheduling. Name the mechanism that preserves each
  write's batch context across the grouped drain (e.g. fork lane-scoped
  execution, or per-write synchronous delivery).
- **Forbid it** (per the preamble rule): reject mixed-context writes inside
  an explicit `batch()` at the write site (detectable: the write's
  classification/batch differs from the batch's opening context — show the
  detection). Then walk the legal compositions that remain:
  `startTransition(() => batch(...))`, plain unbatched writes inside
  `startTransition`, and a provided `startSignalTransition` helper.

The trap either way: any *implicit* grouping (e.g. coalescing broadcasts per
event without user-visible `batch()`) cannot be forbidden — the user wrote
no special code — so implicit grouping must preserve per-write context or
not exist. State which your design does.

## C7 — Writes and reads during a yielded render pass

Schedule: a transition render is time-sliced and yields; during the yield a
click handler runs: reads `a.state`, writes `a.set(x)`; the pass later
resumes.

Required: the handler's read resolves in the **newest** world (not the pass's
pinned world); the write does not throw and is classified/logged under the
click's batch; the resumed pass still observes its original pinned world.

The trap: any "am I in render?" state scoped to [pass-start, pass-end] is
wrong during yields — passes span yields, and handlers run in the gaps. The
fork must expose yield/resume (or equivalent per-callstack truth); the
design must say how reads know.

## C8 — Equality drops must not lose receipts

Setup: `a=0`; deferred T: `a.set(1)`. Then urgent U: `a.set(1)` — equal to
the *newest* value.

Required: U's write must still exist in U's world: U's render (excluding T)
shows 1. If T is later truncated/aborted (where supported), committed value
is still 1. Walk also: two overlapping transitions writing the same value.

Sound rule of thumb (prove yours): dropping an equal write is safe only when
no history exists for the atom — with any history, worlds disagree about the
accumulator, so equality must move to fold/notify time.

## C9 — Mount mid-transition (existing and fresh nodes)

Schedule: transition k writes atoms; while k is pending/rendering, a
component mounts and reads (a) an existing computed over k-touched atoms,
(b) a **freshly created** node (`useComputed` created during this render)
over the same atoms.

Required: both reads resolve in the pass's world (which includes k) on the
first render — no double render, no canonical leak. The trap for (b): a
brand-new node has no marks/edges/shadow yet; the first evaluation may run
before any world-sensitivity is discoverable. State the mechanism (e.g.
evaluate-then-recheck, or eager world-routing for fresh nodes).

## C10 — Late subscription joins the pending batch (entanglement)

Schedule: transition k writes atom `a`; component mounts (subscribes to `a`)
after the write but before k commits; k's world-value for the component
differs from what it rendered.

Required: exactly **one** commit containing both k's updates and the
component's correction (the corrective update is assigned to k's own lanes —
a fresh `startTransition` is NOT equivalent and must be shown why). If k
retires in the race window, fall back to an urgent pre-paint correction.

## C11 — Multiple roots (declared-scope case)

Cross-root *simultaneity* is NOT required — React itself commits roots at
different times, even for one transition. What is required is **per-root
self-consistency** and an explicitly declared scope. The design must pick
and walk one of:

- **Full spanning support**: batch k spans roots A and B; A commits k while
  B is pending. Later renders on A keep including k (A must never contradict
  its own committed DOM); A's passive effects observe k's values after A's
  commit even though the token hasn't fully retired; B eventually commits; k
  retires exactly once. The trap: a single global "committed" world is wrong
  per root during the window.
- **Degraded multi-root**: roots are supported; a spanning batch may commit
  per-root with visible cross-root skew, but each root remains
  self-consistent (no root contradicts its own DOM; corrections are
  urgent-scheduled, bounded, and documented).
- **v1 single-root scope**: a second root is rejected loudly (per the
  preamble rule — detectable at root registration), with the multi-root
  story named as future work and nothing in the architecture that
  forecloses it.

Hidden-gap warning: apps acquire second roots accidentally (portals are
fine — same root; but modals/microfrontends/devtools overlays often use
`createRoot` twice). "Single root" is a legitimate scope only if violation
is detected, not silently wrong.

## C12 — Store-only transitions persist

Schedule: `startTransition(() => a.set(5))` with **no subscribed component**;
also: an async action `startTransition(async () => { a.set(1); await io();
a.set(2) })` with no React work.

Required: the writes commit to canonical state when the batch retires (and
for the async action, not before the action settles). Whether a write
persists must never depend on who is subscribed. (Drop-on-abort killed a
prior candidate; its schedule lives in SCARS.)

## C13 — Counter/world-id lifecycle soundness

Schedule: drive the system to full quiescence (all batches retired, caches
reset); begin a new episode; drive sequence/ticket counters to values that
collide with retained bookkeeping from the previous episode (force small
counters in tests).

Required: no stale cache entry, mark, or world record from a previous
episode can validate in the new one. State every counter, what references
it, and what makes cross-episode reuse safe (epoch bump, generation check,
plane reset — name it per structure). Include forced-wraparound tests for
every counter with a horizon.

## C14 — StrictMode and replayed renders

Required: render-phase reads are pure (no graph mutation observable across a
discarded/replayed pass; no double-fired writes — render-phase writes
throw); double-mounted effects/observed-lifecycle net to one subscription
(microtask flap damping); per-world thenable identity is stable across
replays (same positional thenable per world — or React re-suspends forever).

## C15 — Suspense across worlds (R6 hard case)

Schedule: transition k causes computed `c` to suspend (async data); while
suspended, a component mounts mid-transition reading `c`; promise settles;
React retries.

Required: mount suspends via React `use` protocol against the k-world
thenable; retry re-evaluates through a per-world cache with stable identity;
canonical world never observes the suspension; k commits with settled value.
Also walk: which key identifies "the world" for the thenable cache when a
pass includes multiple batches (a single token is not enough; passSerial
alone re-fetches forever — state your key and its lifetime).

## C16 — Effects observe committed state only

Schedule: urgent write applied but not yet committed (e.g. default-priority
batch D pending render); an unrelated retirement flushes `useSignalEffect`s.

Required: the effect's reads exclude D's applied-but-uncommitted write; after
D commits, the effect re-runs (or first runs) seeing it. Core `effect()` is
allowed a different documented contract (newest), but it must be *stated*
and walked.

## C17 — Optimistic rollback (only if the design exposes truncation)

Schedule: policy API truncates a pending batch's writes mid-flight while
another batch and an open pass exist.

Required: no world ever observes a half-removed batch; caches/memos that
folded the truncated writes invalidate; watchers whose values revert are
notified. If the design does not expose truncation, say so and delete this
surface — React batches themselves never truncate.

---

## Walk format (required per case)

```
C<n>: <one-line restatement>
step | actor/mechanism | state touched (values, marks, edges, log, lanes)
...
outcome: <matches Required because ...>
residual risk: <what could regress this; which test pins it>
```
