# Design: FORK-NATIVE — React owns visibility; the library owns reactivity

Stance: push the multi-world problem as deep into the React fork as it will
go. Verdict up front: the *maximal* form of this stance (React owns
notification and dependency knowledge too, via fibers) is **not viable** —
§12 gives the killing schedules. The viable core presented here keeps a
sharp split: **React owns values, worlds, scheduling, and commit safety; the
signals library owns the dependency graph, cutoffs, and evaluation — as an
accelerator whose mistakes cannot reach the screen.**

---

## 0. One-page summary (the whole concurrency story)

Every atom's value, in React mode, is a **SharedQueue living inside the
fork**: a base value plus an append-only list of lane-tagged update ops —
React's own hook-update-queue algorithm, relocated to a fiber-detached
structure and kept honest by an in-fork differential test against
`useReducer`. There is **no library-side tape, fold, visibility math, or
retirement bookkeeping**: a "world" is a set of batch tokens, and the value
of an atom in a world is `fold(queue, tokens)` computed by the fork with the
exact clause React uses for hook lane filtering (visible iff fully-retired
or token ∈ mask). Writes go through fork `dispatch`, which classifies them
with `requestUpdateLane` (the same function hooks use), appends the op, and
synchronously calls the library back in the writer's context.

Reads route by **React's own execution truth**: inside a render pass (known
per-callstack via an `executionContext` getter — correct across yields, no
new fork state), a read folds the pass's mask through a **per-pass memo**
that dies when the pass ends. Outside render, reads hit a per-atom **hot
slot** (newest value, maintained incrementally on write) or a **per-root
committed fold** (effects). There are **no durable per-world caches**, so
the C1 family has nothing stale to serve: every pass re-evaluates its
touched cone fresh, exactly as React re-renders every fiber with pending
updates in its lanes on every pass until commit.

Notification is the library's job and is treated as a **performance
mechanism, not a correctness axiom**: writes walk the canonical graph
(donor arena kernel; edges re-tracked only by committed-class evaluations)
and deliver `setState` per (watcher, token) in the writer's stack — lane
inheritance for free (D5). Whatever the walk misses — divergent deps,
stale-topology windows, cross-root skew, post-write mounts — is caught by
the **pre-commit gate**: the fork will not commit a root while any watcher's
world-value disagrees with what it rendered; the library validates a small
tagged set (`gateSet`) at `onBeforeCommit` and schedules corrections *into
the committing batch's own lanes* via `runInBatch`, so React re-renders
before mutation. Torn commits are impossible **by construction** (§7): the
thing that publishes frames is the thing that checks them.

Pure-core (no React) users get the donor arena kernel unmodified — the mode
latch is a prototype swap at bridge registration, so DIRECT mode executes
zero concurrency instructions (D1/P3). Cost shape: React-mode reads in
render ≈ the same fold work `useState` itself does per render (P1 parity is
an isomorphism claim, spiked not asserted); quiet-mounted reads are one
empty-queue branch; writes are append + walk ≤ 2× DIRECT; the gate is two
null checks when no transition/stale/skew window is open.

Fork footprint: 2 new files (~550 lines), ~65 touched lines in 4 existing
files, 4 new reconciler concepts (token, SharedQueue, worldId, gate), 16
seam touch points, all edge-triggered from code React already runs. Rebase
drill answer: the library changes **nothing** for lane renames, update-queue
refactors, or commit-phase moves — the fork re-implements the same protocol
facts (§9.8).

Mechanisms: 13 (§3). Every correctness case C1–C17 walked in §10.

---

## 1. Concepts (plain English, defined before use)

- **atom / computed / effect / watcher / tracked read / batch / token /
  render pass / world / retirement** — as in the frozen seeds; restated
  where this design sharpens them.
- **SharedQueue** — a fork-owned record for one atom: `base` (value with all
  fully-retired ops folded in), plus an ordered list of **ops**
  `{token, kind: set|update|dispatch, payload, seq}`. The fork's analogue of
  a hook's update queue, detached from any fiber, shared by all consumers.
- **fold(queue, mask)** — the value obtained by starting from `base` and
  applying, in seq order, every op whose token is fully retired or a member
  of `mask`. This is the design's *only* definition of "the value of atom a
  in world w". It is clause-for-clause React's hook lane filter (D3).
- **world classes** — three, and only three, world shapes are ever read:
  **pass world** (a live render's included tokens ∪ retired), **committed
  world of root r** (tokens committed on r ∪ retired), **newest** (all
  tokens). No other world is materialized.
- **hot slot** — per-atom cached `fold(queue, ALL)` (newest), updated in
  O(1) on each write by applying the op to the previous hot value.
- **committed view** — per-(atom, root) cached committed-world value,
  advanced at retirement/commit callbacks.
- **canonical graph** — the library's dependency graph (donor arena kernel
  layout). Its edges are re-tracked **only by committed-class evaluations**
  (§6.2); deferred-world evaluations never write edges. Edges are an
  accelerator for delivery, not the source of truth for commits.
- **committed-class evaluation** — an evaluation whose world mask contains
  no live deferred token (i.e. fully-retired ∪ urgent-committed for the
  evaluating root, or fully-retired for root-agnostic core effects).
- **per-pass memo** — a table (nodeId → {value, readSet}) keyed by the
  fork's `passSerial`; created at `onPassStart`, discarded at `onPassEnd`.
  All render-world evaluation goes through it. Nothing evaluated under a
  mask containing live tokens outlives its pass (§8), except suspense
  thenable identities (§8.1).
- **worldId** — a fork-minted stable identity for (root, included-token-set),
  stable across a batch's yields, restarts, and suspense retries; retired
  when any member token retires. The suspense cache key (C15, O8).
- **passSerial** — a fork-minted identity for one render attempt (fresh
  stack → completion/discard). Memos key on it; restarts get a new one.
- **gateSet** — a small library-side registry of watched nodes whose
  canonical edges may not match some root's committed-world read set, each
  entry tagged with the token mask that must validate it before committing
  (§7.2).
- **slot / slotClock / slotGen** — live batches interned into ≤31 slots
  (I10); `slotClock[s]` bumps on every write in that batch; `slotGen[s]`
  bumps on slot recycle so retained clock records can never validate across
  reuse (C13, I8).
- **mode latch** — process-global, monotonic DIRECT→REACT switch at bridge
  registration (D1, S6): implemented as a prototype/getter swap so DIRECT
  code paths contain zero concurrency instructions.

---

## 2. Architecture: what lives where, and the two inversions

**Fork owns (because only it can, or because parity is then structural):**

1. Value storage + visibility + rebase: SharedQueue ops and `fold` are
   React's updater-queue arithmetic. C2/C3/C8/C12-class semantics are not
   *reimplemented to match* React — they are the same algorithm, pinned by
   an in-fork differential test that drives identical schedules through
   `useReducer` and a SharedQueue and asserts equality at every render and
   commit.
2. Write classification: `dispatch` calls `requestUpdateLane` internally;
   "which batch is this write in" never crosses the seam as a question, only
   as an answer (token).
3. Pass truth: which tokens a pass includes, whether *this callstack* is
   rendering (executionContext — already correct across yields, S7/I6),
   pass restarts when a write lands in rendered lanes.
4. Commit safety: the pre-commit gate edge. Userspace cannot hold a commit;
   the fork can. This converts notification completeness from a correctness
   axiom into an optimization (inversion #1).
5. Retirement: exactly-once per token, per-root commit masks (C11), async
   action parking (C12).

**Library owns (because atoms are many-consumer and React has no home for
graph knowledge — the honest confrontation of the stance):**

1. The dependency graph, equality cutoffs, lazy pull, exact pull counts —
   the alien-signals-class core (donor arena kernel), untouched in DIRECT
   mode (P2).
2. Delivery: per-write walks that `setState` watchers in the writer's
   context (D5), with per-(watcher, token) dedup (I5-compliant).
3. Evaluation in worlds: per-pass memo, gate sweeps, mount fixups — all
   *transient*; durable caches exist only for the two fixed world classes
   (hot, committed) that are maintained incrementally (inversion #2: there
   is no per-world cache-invalidation problem because there are no durable
   per-world caches).

**Why the graph cannot move into React** (summary of §12): computed-grain
equality cutoff requires a node between atom and component; flattening
dependencies to fibers re-renders every subscriber on suppressed writes
(C5's suppression, P1's 10k case); computeds and core `effect()` exist
outside any fiber (R13); per-computed hidden fibers destroy creation
benchmarks (P2/P4). The graph stays in the library — but demoted to an
accelerator, with the gate as the safety net.

---

## 3. Mechanism inventory (13 — the judge counts)

| # | mechanism | side | one-line role |
|---|---|---|---|
| M1 | SharedQueue: per-atom op log + base + `fold(mask)` | fork | all multi-world value semantics (D3) |
| M2 | Token/batch registry: mint, deferred bit, per-root commit masks, exactly-once retire, async parking | fork | batch lifecycle, C11/C12 |
| M3 | Render-context protocol: executionContext getters, passSerial/worldId, PF-invariants (fresh re-render per pass, restart on in-mask write) | fork | C1/C7/C9 world routing |
| M4 | `runInBatch(token, fn)` lane-scoped scheduling | fork | C6/C10 corrections into existing batches |
| M5 | Pre-commit gate + gateSet (token-tagged validation registry) | fork edge + library sweep | structural no-torn-commit (§7) |
| M6 | Single-world view caches: hot slot + per-root committed folds | library | untracked/core/effect reads, O(1) maintenance |
| M7 | Canonical graph, committed-class-only re-tracking | library | delivery topology + core cutoffs (donor kernel) |
| M8 | Per-write walk, per-(watcher,token) dedup, setState in writer's context | library | D5 delivery, C4/C5 granularity |
| M9 | Per-pass memo + transient read-set capture + commit-time edge adoption | library | fresh per-pass worlds, C1 family, §8 |
| M10 | Per-(node, worldId) thenable/sentinel cache | library | suspense/error identity, C15/R2 |
| M11 | Slot write clocks + slotGen generation guards | library | gate/fixup filters, C13/I8 |
| M12 | Mount fixup via runInBatch | library | C10 late subscription |
| M13 | Mode latch (DIRECT→REACT prototype swap, monotonic) | library | D1/P3/S6 |

No second kernel, no per-link world bits, no read certificates, no
world-memo validity machinery: those exist to keep *durable* per-world
caches honest, and this design has none.

---

## 4. Value semantics (M1, M2, M6)

### 4.1 SharedQueue and fold

Created lazily on an atom's first React-mode write (`createQueue(initial)`);
quiet atoms carry only an undefined `queueId` field. Ops append with a
global monotonic `seq`. The visibility rule, verbatim from the mechanism
library and React's own filter:

```
visible(op, mask) := fullyRetired(op.token) ∨ op.token ∈ mask
fold(q, mask)     := reduce(q.base, ops where visible, in seq order,
                            apply set/update/dispatch)
```

`base` advances (ops removed, folded in) only under React's own baseQueue
rule: a prefix of ops folds when every op in the prefix is fully retired
**and** no earlier-seq op remains (first unretired op freezes the base) —
identical to "first skipped update freezes baseState". Invariant
QUEUE-STABLE: base advance never changes `fold(q, m)` for any mask m that
any live consumer can hold, because advance requires full retirement, and
every readable mask includes fully-retired tokens by the visibility rule.
(Base case: empty queue, trivially stable. Step: advancing over op o
requires fullyRetired(o.token); every fold, for every world class, includes
fully-retired ops; so folding o into base removes it from the list and adds
it to every fold identically. ∎)

### 4.2 Rebase parity is inherited, not imitated

`update(fn)` and `dispatch(action)` ops store the function/action, not a
result: folds replay in write order over the pre-batch base — I2's only
parity-correct fold. The fork test suite runs the C3 battery through a real
`useReducer` and a SharedQueue side by side (T-SQ1) and a property/fuzz test
comparing `fold` against the hook lane filter on random schedules (T-SQ2).
Equal-value writes always append when the queue is non-empty (I7/C8);
with an empty queue and no live batches, a `set` equal to base is dropped
(safe by I7: the dropped op would hold the lowest seq in every fold) and an
`update` is evaluated once against base and dropped if equal.

### 4.3 The three world classes and their caches

- **newest**: hot slot per atom, updated O(1) at dispatch (apply op to
  previous hot). Serves untracked reads, `atom.state` outside render.
- **committed(root)**: per-(atom, root) value advanced at `onCommit`
  callbacks (fold of retired ∪ committed[root]); serves `useSignalEffect`
  and canonical evaluations for that root. Root count is small; storage is a
  side map touched only at commit edges.
- **pass world**: never cached durably; served by fold + per-pass memo.

**Core `effect()` contract in React mode (C16, R13, documented):** core
effects observe the **fully-retired world** (root-agnostic committed
class) and re-run on retirement edges. In DIRECT mode they observe writes
immediately and synchronously flushable (alien semantics; the benchmark
adapter runs DIRECT, satisfying R13's integrability: exact pull counts,
synchronous effects under the documented config). This choice is what keeps
canonical edges pure (§6.2) — a newest-world tracking contract would let
deferred values steer edge re-tracking, reopening the T4 poison walked in
§6.2. Stated, priced (core effects lag until retirement in React mode),
and walked in C16.

---

## 5. Read and write paths

### 5.1 Reads

```
tracked read of atom A during evaluation E:
  E.context was captured ONCE at E start (evaluations are synchronous,
  never span yields):
    - E in pass P (getRenderContext() ≠ undefined at E start):
        memo[P.serial][A] ?? fold(A.queue, P.mask)   [readInPass]
    - E committed-class (effect flush, canonical pull for root r):
        committedView(A, r)                          [library cache]
    - E in DIRECT mode: plain slot in arena          [donor kernel]
untracked / top-level read: hot slot (newest) — or plain slot in DIRECT.
```

One `getRenderContext()` call per *evaluation*, not per read (evaluations
are synchronous, so per-callstack truth cannot change mid-evaluation; C7's
handler-in-yield-gap runs its own evaluations and captures its own
context). Components' hook reads capture context per render-function
invocation the same way.

### 5.2 Writes

```
atom.set(v) in React mode:
 1. fork dispatch(queueId, op):
    - classify via requestUpdateLane (native) → token t (minted lazily,
      deferred bit for transition lanes)
    - append op {t, kind, payload, seq++}; mark roots with pending t-lane
      work as React does for any update
    - PF-3: if t ∈ any in-flight or completed-uncommitted pass's mask on a
      root → that root re-renders t before committing (protocol invariant,
      fork test T-PF3)
    - synchronously call onWrite(queueId, t, deferredBit)  [writer's stack]
 2. library onWrite:
    - hot slot ← apply op; slotClock[slot(t)]++
    - if render callstack (getRenderContext() at write site): THROW —
      render-phase writes are rejected (C14, R8) using native truth
    - per-write walk (M8): traverse canonical edges from A; for each
      watched node reached, if lastDelivered[watcher][t] unset: setState in
      the CURRENT stack (React assigns t's priority natively — D5) and set
      the dedup bit; for each stale-marked watched node encountered or
      newly marked while live deferred tokens exist: gateSet.add(node,
      liveDeferredMask | t) (§7.2)
    - equality: no eager per-world evaluation on the write path (the
      priced-expensive shape, research-facts G-7); quiescent-empty-queue
      drops per §4.2 only
DIRECT mode: donor kernel propagate; zero of the above instructions (M13).
```

Dedup soundness (I5-compliant): per-(watcher, token), *not*
once-per-staleness. A second write in the **same** token needs no second
setState because a scheduled fiber re-renders fresh in every subsequent
pass for that token until commit (PF-2) and evaluations go through the
per-pass memo, which folds the newest ops. A write in a **different** token
gets its own setState in that token's context (C4).

### 5.3 Hooks (R4) and watcher records

`useAtom`/`useComputed`/`useReducerAtom` mount a watcher record: {fiber
setState, nodeId, lastRenderedValue, lastRenderMask, per-slot
(gen, clockAtRender) for slots in that mask}. Updated at every completed
render of the component (cheap ref stores in the hook read path).
`useComputed(fn, deps)` creates a per-fiber node; render-phase creation
evaluates immediately in the captured context (pass world — C9(b) needs no
recheck because the *first* evaluation already routes by mask; a fresh node
needs no marks or edges to read correctly). Subscription happens in the
effect phase + mount fixup (M12, C10). Provider-free (global bridge);
no provider component is needed because the seam is process-global and
feature-detected (§9.6).

---

## 6. Notification: the walk, edge purity, and schedule-completeness

### 6.1 What the walk is for

The walk's ONLY correctness obligation is to *usually* deliver setStates
promptly so the gate finds nothing; the gate (§7) is the guarantee. This
demotion is deliberate: every prior scar in this family (S2, S3, S5) came
from a walk or certificate that *had* to be complete and wasn't.

### 6.2 Edge purity: committed-class re-tracking only

Canonical edges are (re-)tracked exclusively by committed-class
evaluations. Deferred-pass evaluations capture read sets into the pass memo
(transient) but never write graph edges.

Why (the T4 poison, walked): let c = `flag ? a : b`, committed flag=false.
Transition k sets flag=true; a k-pass evaluates c and — if it re-tracked —
edges become {flag, a}. Now an **urgent** write to b: the walk from b finds
no edge, no watcher setState; urgent commits are the fast path, and b's
change is committed-world-visible ⇒ stale frame. With committed-class-only
re-tracking, edges stay {flag, b}; the urgent b-write walks straight to the
watcher. Deferred worlds get no topology — they don't need one, because:

### 6.3 Construction B — schedule-completeness (the load-bearing induction)

**Premises** (each pinned by a named mechanism/test):

- (P-walk) every React-mode write synchronously walks current canonical
  edges with per-(watcher, token) dedup (M8).
- (P-fresh) a watched node's canonical edges equal the exact read set of
  its latest committed-class evaluation; and whenever any edge-atom's
  committed-class value changes, the node is stale-marked by that write's
  walk before the change is committed (self-closing: the changing atom IS
  in the edge set). Nodes whose edges may disagree with some root's
  committed read set are exactly the stale-marked-or-skew-or-adoption
  cases, and each such node is in gateSet tagged for every token that must
  re-check it (§7.2).
- (P-pass) a fiber with a pending update in token t re-renders fresh
  (through the per-pass memo) in every pass that includes t, until t
  commits (fork test T-PF2 — React-native: uncommitted lanes stay on the
  fiber; renders for those lanes never bail out).
- (P-restart) a write in token t while a t-including pass is in flight or
  completed-but-uncommitted forces a new t-pass before commit (T-PF3).
- (P-pure) computeds are pure and render-phase writes throw (C14/R8), so
  two evaluations that read equal values for every atom read return equal
  values and equal read sets (first-divergence usable, I4).

**Claim.** At every commit of mask M on root r, every mounted watcher W on
r satisfies: rendered(W) = value of W's node in fold-world
(committed[r] ∪ M) — i.e. no torn or stale commit.

**Proof.** Induction over commits on r in order.

*Base:* before the first commit nothing is published; a first commit's pass
rendered every fiber in the mounting tree through the per-pass memo, so
every watcher's output IS the pass-world value (M9), and the pass world is
the commit world (P-restart guarantees no in-mask write slipped between
completion and commit without a re-pass).

*Step:* assume all previous commits clean. Take commit of M; let W be a
watcher not rendered in M's final pass (rendered ones are correct by M9 +
P-restart as in the base). Let V = fold-world (committed[r] ∪ M),
V₀ = W's world at its last render (clean by IH: rendered(W) = value in V₀,
and V₀ ⊆ V as committed masks only grow and M's extra tokens are the
committing ones). Suppose value(W, V) ≠ rendered(W) = value(W, V₀). By
P-pure, compare the two evaluations: there is a first read position where
they disagree, at an atom d with fold(d, V) ≠ fold(d, V₀); the read prefix
before d is identical in both, so d is in the read set of the V₀-evaluation
— which is W's node's latest committed-class-consistent read set. Two
cases: (i) the node's canonical edges contain d (fresh case): fold(d, V) ≠
fold(d, V₀) means some op on d has token t ∈ V∖V₀ ⊆ M ∪ (committed since
V₀); that op's write walked edge d→…→W (P-walk) and delivered setState(W, t)
— if t committed earlier, W rendered in t's commit (IH covers), contradiction
with V₀ lacking t; if t ∈ M, W has a pending t-update, so P-pass renders W
in M's final pass — contradiction with "not rendered". (ii) the node's
edges do not contain d: then edges disagree with the node's committed-class
read set, so by P-fresh the node ∈ gateSet tagged with a mask containing
every live token that must validate it (stale-window, skew, mount-gap, or
adoption tags, §7.2 enumerates why the tags cover t); the gate (§7.1)
evaluates value(W, V) before this commit, detects the difference, schedules
setState(W) into M's lanes via runInBatch, and the fork re-renders before
committing — so W *was* rendered in M's final pass, contradiction. Both
cases contradict; hence value(W, V) = rendered(W). ∎

The gate makes case (ii) mechanical rather than clever; §7.2's tag
obligations are the only completeness debt, and they are enumerable.

---

## 7. The pre-commit gate (M5) — structural no-torn-commit

### 7.1 Protocol

When a root's render for mask M completes, before the mutation phase, the
fork calls `onBeforeCommit(root, M, passSerial)`. The library:

1. Fast-out: if gateSet is empty AND no live deferred token wrote anything
   (all slotClocks unchanged since last commit on this root) AND no
   spanning-skew window is open → return (two null checks + one branch;
   this is the P1 typing path).
2. Otherwise sweep: for each gateSet entry whose tag mask intersects M ∪
   committed[root]-deltas: evaluate the node in fold-world
   (committed[root] ∪ M) (via `readInWorld`, memo-shared across the sweep),
   compare against each subscribed watcher's lastRenderedValue; on
   mismatch, `runInBatch(t∈M, () => setState(watcher))`.
3. If any corrections were scheduled, the fork sees new work in M's lanes
   and re-renders before committing (native loop; bounded by React's own
   nested-update limit — a diverging correction loop surfaces as React's
   own "maximum update depth" error, R7). Clear the validated token bits
   from swept entries; entries die at mask 0.

Urgent commits run the same gate; their sweep set is empty unless a
stale/skew/mount window is open (fast-out), so typing costs two checks.

### 7.2 gateSet: who gets tagged, and why the tags suffice

An entry is (nodeId, tokenMask). Sources — each is a *detected event*, not
a sampled condition:

- **stale-window**: a write's walk stale-marks a watched node (or meets an
  already-stale one) while live deferred tokens exist → add with
  (liveDeferredMask ∪ writing token). Covers: writes that land while the
  node's edges are provisional (the §6.2 windows) — any token alive during
  the window is tagged, and tokens minted later see fresh edges (the node
  re-evaluates canonically before its watcher's scheduled render commits,
  because the marking write also delivered setState in its own lane and
  commits are gated in order).
- **skew-window** (C11 full scope): when a node's committed-class
  re-tracking happens under root r while another root r′ has a
  committed-mask differing from fully-retired (a spanning batch is half
  landed) → add with the skew tokens; cleared as they fully retire.
- **mount-gap**: mount fixup (M12) found live deferred tokens at layout
  time → the subscribed node is tagged with them until each validates
  (C10's race belt).
- **adoption-pending**: a node whose ONLY evaluations ever ran in
  deferred-world passes (mounted mid-transition; no canonical edges yet) is
  tagged with all live tokens until commit-time edge adoption (§7.3) or a
  canonical evaluation gives it real edges. Gate evaluations themselves
  adopt when their world equals the new committed class (self-healing).

Boundedness: entries require a live deferred token or an open skew window;
≤31 live tokens (I10); entries are per *watched* node in an active window —
transient few. A fuzz oracle asserts a classification for every gate find
(any find outside these classes is a delivery bug to fix, not a silent
save).

### 7.3 Commit-time edge adoption

At `onCommit(root, tokens)`, for each pass-memo node whose evaluation mask
equals the new committed class of that root (single-batch commits — the
common case), adopt its captured read set as canonical edges (they are, at
this instant, exactly the committed-class read set — the pass world just
became the committed world). Multi-batch passes (rare) skip adoption and
stay gate-resident until a canonical evaluation. This keeps
mid-transition-mounted nodes from being permanent gate residents.

---

## 8. Construction A — no durable per-world caches

**Claim.** No value computed under a mask containing a live token is ever
readable after the pass (or sweep/fixup scope) that computed it.

*Base:* the only entry points to live-mask folding are readInPass (memo
keyed passSerial, table dropped at onPassEnd — restarts mint a new serial),
gate sweeps (sweep-local memo, dropped at return), and mount fixups
(commit-scoped memo, dropped at return). Each is lexically scoped; there is
no other store keyed by a mask or token that holds *values*.

*Step:* the durable caches are hot (mask = ALL — no live-token
distinction), committed views (mask = retired ∪ committed[root] — advanced
only at commit edges, never containing an uncommitted token), and canonical
node caches in the arena (written only by committed-class evaluations).
None can hold a live-deferred-world value. ∎

**Carve-out (stated, not hidden):** the thenable/sentinel cache (M10) keys
(node, worldId, position) and outlives passes *by design* — C15/R2 require
stable suspense identity across retries. It stores request identities
(thenables) and error boxes, not folded values: retries re-*evaluate* the
computed (fresh folds) and only reuse the thenable at the same position
with equal args (args mismatch mints a new one). Entries die when their
worldId retires (any member token retires ⇒ that world can never render
again). This is the single world-keyed durable structure and its lifetime
is fork-managed.

---

## 9. fork-protocol (the seam — versioned, complete)

Protocol version: `cosignal-fork/1`. Bindings call `registerBridge` and
hard-fail on absence or version mismatch (no silent degraded mode).

### 9.1 Controls (library → fork), 9

| # | signature | semantics |
|---|---|---|
| S1 | `registerBridge(cbs, version) → {caps}` | handshake; latches REACT mode (M13); idempotent-per-process |
| S2 | `createQueue(initial) → queueId` | lazy, at first React-mode write of an atom |
| S3 | `disposeQueue(queueId)` | atom GC; illegal with live ops (fork asserts) |
| S4 | `dispatch(queueId, op) → {token, deferred}` | classify (requestUpdateLane), append, schedule roots, PF-3, then sync onWrite |
| S5 | `readInPass(queueId) → value` | fold with the current callstack's pass mask (asserts in-render) |
| S6 | `readCommitted(queueId, rootId) → value` | fold retired ∪ committed[root] (library caches per M6; this is the cache-fill path) |
| S7 | `readInWorld(queueId, tokens[]) → value` | explicit-mask fold; gate sweeps and mount fixups only |
| S8 | `runInBatch(token, fn) → boolean` | run fn so its updates join token's lanes; false if retired (caller falls back urgent) |
| S9 | `getRenderContext() → undefined \| {rootId, tokens[], passSerial, worldId}` | per-callstack truth from executionContext + wip lanes; correct in yield gaps (I6) with **zero new fork state** |

### 9.2 Callbacks (fork → library), 7

| # | signature | edge-triggered from | invariant documented at site |
|---|---|---|---|
| C-1 | `onWrite(queueId, token, deferred)` | dispatch (writer's stack) | fires after append, before dispatch returns; sync |
| C-2 | `onPassStart(rootId, tokens[], passSerial, worldId)` | prepareFreshStack | new serial per attempt; worldId stable per (root, token-set) |
| C-3 | `onPassEnd(passSerial, completed)` | workLoop exit/discard | memo lifetime bound; fires for discards too |
| C-4 | `onBeforeCommit(rootId, tokens[], passSerial)` | pre-mutation | commit blocked until return; corrections via S8 re-enter render |
| C-5 | `onCommit(rootId, tokens[])` | commitRoot tail | per-root lock-in (C11); committed views advance; edge adoption |
| C-6 | `onRetire(token, folded)` | last observing root committed, or batch closed with no work (async actions parked until settle) | exactly once; base advance per §4.1; D2: always folds |
| C-7 | `onMutationWindow(rootId)` | mutation phase | charter nicety (DOM-coordinated writes) |

Seam touch points: **16**. No Fiber objects, no lane bitmasks, no
update-queue internals cross; integers, values, and documented callbacks
only (charter hard rule).

### 9.3 Protocol invariants (each carries a fork reconciler test)

- PF-1: `getRenderContext()` ≠ undefined ⟺ the callstack is inside a render
  pass; yields flip it off, resume flips it on (T-PF4 renders with
  time-slicing, dispatches from a timer in the gap, asserts undefined).
- PF-2: a fiber holding a pending update in token t renders fresh in every
  t-including pass until t commits (T-PF2).
- PF-3: a dispatch whose token is in an in-flight or completed-uncommitted
  pass's mask forces a fresh pass before commit (T-PF3 exercises both
  windows, including the suspended-commit window).
- PF-4: pass mask reported = the fold-visible token set of that render's
  lanes; equals what hook queues would apply (T-SQ2 property test).
- PF-5: onRetire exactly once per token, after all observing roots commit
  or the batch closes; async actions park it (T-RET1/2/3).
- PF-6: worldId stable across yields, restarts, and suspense retries for
  the same (root, token-set); fresh set ⇒ fresh id; retired with tokens
  (T-WID1).
- PF-7: runInBatch updates join the token's lanes and commit in that
  batch's single commit; returns false after retire (T-RIB1).
- PF-8: onBeforeCommit corrections re-enter render before mutation; loop
  bounded by React's nested-update limit (T-GATE1).
- PF-9: stock-React detection fails loudly (T-VER1).

### 9.4 Fork internal design (size & placement)

New files: `ReactFiberSharedQueue.js` (~350 lines: queue store, fold, base
advance, differential-test hooks) and `ReactFiberSignalBridge.js` (~200:
registry, token minting/interning, per-root masks, parking, gate edge,
worldId minting, context getters). Touched: `ReactFiberWorkLoop.js` (~30
lines: C-2/3/4/5 call sites + getter exports), `ReactFiberRootScheduler.js`
(~15: retirement edges, parking), `ReactFiberLane.js` (~10: token↔lane
helpers), `react` package exports (~10). Every touch is edge-triggered from
a place the reconciler already mutates its own bookkeeping; each site is
one null-checked call, inert with no bridge (charter goal 2). New concepts
in reconciler code: token, SharedQueue, worldId, gate — 4.

### 9.5 The rebase drill (charter goal 3)

| React changed… | fork moves | library moves |
|---|---|---|
| lane names/bit layout | token↔lane helpers, registry internals | **nothing** (tokens are minted integers) |
| update-queue internals (hooks) | nothing structural (SharedQueue is a standalone clone); T-SQ1/T-SQ2 differential suite flags semantic drift → update the clone | **nothing** |
| commit phases moved/split | re-site C-4/C-5/C-7 (one call each; invariants documented at site) | **nothing** |
| scheduler/yield mechanics | PF-1 getter reimplemented over new executionContext shape | **nothing** |
| hook implementation rewritten | nothing (we never touch hooks) | **nothing** |

The signals library depends on `fork-protocol.md` §9.1–9.3 only. The
answer to the drill is "nothing; the fork re-implements the same protocol
facts" — achieved by keeping every React-internal concept on the far side
of integer tokens and 16 documented endpoints.

### 9.6 Version skew & feature detect

`registerBridge` checks a fork-exported protocol constant; absence (stock
React) throws at binding import time with a named error. No degraded mode.

### 9.7 SharedQueue-in-fork vs in-library (honest accounting)

The queue could live library-side consuming the same protocol (S4 would
return classification only). Fork-side placement buys: (a) the differential
CI against useReducer runs inside one build, pinning parity as a fork test;
(b) retirement/base-advance sits next to the commit code that triggers it;
(c) `readInPass` never crosses the seam twice per read. It costs fork size
(~350 lines, the largest single item). This is the stance's centerpiece
bet; §12's fallback line names the retreat (move the queue out, keep
everything else) if rebase economics sour — the seam shape survives either
placement.

---

## 10. Case walks (required format)

Notation: `q(a)=[...]` SharedQueue ops as `token:op`; `hot(a)`; `cm(r)` =
committed mask of root r; masks in folds always implicitly include fully
retired tokens; `W⟵setState@t` = delivery in token t's context; `memo(Pn)`
= per-pass memo of pass serial n.

### C1: divergent dep write invalidates the pending world and re-renders W in k's lane pre-commit

```
step | actor/mechanism | state touched
1 | k: flag.set(true) → S4/M1 | q(flag)=[k:true]; hot(flag)=true; clock[k]=1
2 | onWrite walk (M8), edges(c)={flag,b} | flag→c→W: W⟵setState@k; dedup[W][k]=1
3 | k-pass P1 (M3): W renders | memo(P1): c := fold(flag,{k})=true → fold(a,{k})=0 → c=0; W.lastRendered=0, mask={k}, clocks{k:1}; NO edge re-track (deferred world, §6.2)
4 | k: a.set(1) → S4 | q(a)=[k:1]; hot(a)=1; clock[k]=2; PF-3: k in P1's mask (in-flight or completed-uncommitted) → fork schedules fresh k-pass
5 | onWrite walk from a | edges(c)={flag,b}: no a-edge → no delivery (expected; a is divergent) — W already scheduled (step 2 pending update, PF-2)
6 | k-pass P2 | memo(P2) fresh: c := true→fold(a,{k})=1 → c=1; W renders 1 (P-pass: pending k update ⇒ no bailout)
7 | gate at k commit (M5) | W rendered in P2 ⇒ validated by render; gateSet empty → commit; cm(r)+={k}; W shows 1
8 | committed world before step 7 | fold(c-world committed) : flag=false → b=0 → c=0 ✓ (served canonically; k ops invisible)
outcome: k-world cache invalidated trivially (memo died with P1); W re-rendered in k's lane before commit (steps 4–6, PF-3+PF-2); committed reads 0 until commit. Matches Required.
residual risk: PF-3's completed-uncommitted window regressing in a rebase — pinned by fork test T-PF3; delivery-less correctness relies on PF-2 — T-PF2.
```

**C1-T2** (k writes committed-only dep b; k-world unchanged):
```
1 | k: b.set(9) | q(b)=[k:9]; clock[k]=3
2 | walk from b: edges(c)={flag,b} → c → W | dedup[W][k] set → no second setState (same token)
3 | PF-3 → k-pass P3: W renders fresh | c: flag(k)=true → a(k)=1 → c=1 (b unread in k-world) — output unchanged; React commits no DOM change
4 | committed pre-commit | c committed = b? no: flag=false → b: fold(b, cm)=0 (k invisible) = 0 ✓; post-commit: flag=true → a=1 → c=1; b irrelevant
outcome: over-invalidation only (one no-op render); wrong value impossible (fold is per-mask). ✓
residual risk: none beyond PF-2; pinned by T-PF2.
```

**C1-T3** (flag flips back in k):
```
1 | k: flag.set(false) | q(flag)=[k:true, k:false]; walk: dedup → no new setState; PF-3 → pass P4
2 | P4: W renders | c: fold(flag,{k}) = replay true,false = false → fold(b,{k})=0 → c=0 == committed → same output, commit no-op
outcome: correct via seq-order replay in fold. ✓  residual: fold order — T-SQ2 fuzz.
```

**C1-T4** (urgent write to b while k live):
```
1 | U: b.set(5) → S4 | q(b)=[k:9?...] (T2 aside; take base family: q(b)=[U:5]); hot(b)=5; clock[U]=1
2 | walk from b: edges(c)={flag,b} | W⟵setState@U (dedup[W][U])
3 | U-pass (urgent, mask={U}): W renders | c: fold(flag,{U})=false → fold(b,{U})=5 → c=5; committed-class eval → RE-TRACK edges(c)={flag,b} (unchanged); U gate: fast-out unless windows open → commit; cm+={U}
4 | k-pass after U commit (mask={k}∪cm ⊇ {U,k}) | W (pending k update) renders: flag(k)=true → a(k)=? (family: a=1) → c=1
outcome: committed changed via U ✓; k-world composes over it (pending worlds include committed urgent state — T5's rule) ✓.
residual: priority inversion (k committing before U renders) — gate covers via stale/skew tags; fuzz oracle asserts gate-find classification.
```

**C1-T5** (urgent write to a — k-world sees it):
```
1 | U2: a.set(7) | q(a)=[k:1, U2:7]; walk from a: edges(c)={flag,b} → no delivery (a not a committed dep) — CORRECT: committed c unaffected (flag=false)
2 | U2 render+commit: no watcher scheduled; gate fast-out (no stale windows; a's write marked nothing watched) → commit; cm+={U2}
3 | next k-pass (PF-3 fired at step 1? U2 ∉ k's mask → no restart needed; k renders on its own schedule; mask now {k}∪cm∋U2) | c: flag(k)=true → fold(a, {k}∪cm) = replay k:1 then U2:7 in seq order = 7 → c=7; W renders 7
outcome: pending world includes applied urgent state via mask ⊇ cm ✓.
residual: none new; fold-order fuzz T-SQ2.
```

**C1-T6** (slot/world-id reuse after k retires): walked in C13 below (same
mechanisms: slotGen guards, token monotonicity, worldId retirement).

**C1-T7** (two live batches render together; one suspends, one commits alone):
```
1 | k1,k2 live; pass P5 mask={k1,k2}, worldId w12 | memo(P5); c suspends on k2 data → thenable cached (c, w12, pos0)
2 | React splits: retry k1 alone: pass P6 mask={k1}, worldId w1 (PF-6: different set ⇒ different id) | memo(P6) fresh; c(k1-world) doesn't suspend → renders; gate validates P6's watchers; k1 commits; cm+={k1}
3 | k2 data settles; pass P7 mask={k2}∪cm, worldId w2' | thenable for w12? w12 dies when… k1 committed ⇒ set {k1,k2} can still render? No: renders are per-mask {k2}∪cm now — new worldId; c re-evaluates; ctx.use position 0 args equal → NEW world's cache empty → mint/reuse per args (§8.1); settled promise reused if args-equal via library-level request dedup (documented)
4 | k2 commits; onRetire(k1), onRetire(k2) exactly once each (PF-5)
outcome: per-mask folds keep both views consistent; no cross-world thenable bleed (worldId keying). ✓
residual: request-level dedup across worldIds is a policy choice (documented); pinned by C15 harness scenario.
```

### C2: flushSync excludes a pending default batch

```
step | actor/mechanism | state touched
1 | event: a.set(1) → S4 | classify: default lane → token D (deferred=0, still logged — always-log D1/I1); q(a)=[D:1]; hot(a)=1
2 | onWrite walk | edges(c)={a}: W_c⟵setState@D; W_a⟵setState@D
3 | flushSync(setStateX) → sync pass mask={Sync} (D excluded — native lane filtering) | X renders; W_a/W_c have only D-lane updates → not rendered (React skips), keep showing 0/10 ✓; if a parent re-render forces W_a/W_c into this pass: readInPass folds mask {Sync}: a=0; memo: c=0+10=10 ✓ both
4 | gate at sync commit | fast-out (no deferred live, no windows) → commit; screen: a=0, c=10 consistent
5 | D renders (async, mask={D}) | W_a: a=1; W_c: c=11; gate; commit; onRetire(D) → base(a)=1
outcome: both a=0 AND c=10 in the flushSync frame — no canonical cache can leak because render reads never touch hot/committed caches; they fold the pass mask. Matches Required.
residual risk: a future "skip logging for urgent" optimization — forbidden by D1/I1; pinned by fork test T-C2 (end-to-end flushSync scenario).
```

### C3: rebase parity

```
step | actor/mechanism | state
1 | T: a.update(x=>x+1) | q(a)=[T:+1]; base=1
2 | U: a.update(x=>x*2) | q(a)=[T:+1, U:×2]
3 | urgent pass mask={U} | fold: base 1 → skip T → ×2 = 2 ✓ render shows 2
4 | U commits | cm+={U}; base advance blocked (first op T unretired — §4.1 freeze rule); base=1
5 | T pass mask={T,U} | fold: (1+1)×2 = 4 ✓ render shows 4
6 | T commits → onRetire(T), onRetire(U) | base=(1+1)×2=4 ✓ committed 4
7 | differential | T-SQ1 runs the same schedule through useReducer: 2, then 4, then commit 4 — asserted equal at every step
plain-set variant | q=[T:+1, U2:set5]: U2 render: 1→set5=5; T render {T,U2}: (1+1)→set5=5; commit 5 ✓ (set overrides in write order)
outcome: replay-in-write-order over pre-batch base (I2) is literally the fold. Matches Required.
residual risk: clone drift from React's queue semantics — pinned by T-SQ1/T-SQ2 differential CI.
```

### C4: two-batch write into an already-stale region

```
1 | T1: a.set(1) | walk: edges(c)={a} → W⟵setState@T1; dedup[W][T1]
2 | (no render yet) T2: a.set(2) | q(a)=[T1:1, T2:2]; walk again — dedup is per-(W, token): T2 ∉ dedup[W] → W⟵setState@T2 ✓
3 | T1 pass mask={T1} | W renders c=1 (fold skips T2)
4 | T2 pass mask={T2}∪cm | W renders c(T2-world) = replay T1? T1 ∈ cm iff committed; if T1 uncommitted: fold {T2} = base+T2:2 = 2; if committed first: 1 then 2 by seq = 2 ✓
outcome: W scheduled in T2's lane by per-write, per-token delivery — no once-per-staleness mark exists to stop it (I5 honored structurally). ✓
residual risk: a future walk-dedup "optimization" collapsing token granularity — pinned by a C4 unit test asserting two setStates with distinct tokens.
```

### C5: cutoff-suppressed first write, effective second write (same batch)

```
setup | c = a*0 + b; edges(c)={a,b}; W on c
1 | k: a.set(1) | q(a)=[k:1]; walk: W⟵setState@k (no eager evaluation on write path — no suppression at delivery; §5.2)
2 | k-pass | W renders: c = 1*0 + fold(b,{k})=b₀ → value unchanged → output identical → React commits no DOM change (cutoff realized as output-equality, not suppressed delivery)
3 | k: b.set(7) | q(b)=[k:7]; walk: dedup[W][k] set → no new setState; PF-3 → fresh k-pass
4 | k-pass P′ | W renders fresh (PF-2): c = 0 + 7 = 7 ✓
5 | gate → commit | W validated by render; commit shows 7
outcome: second write reaches the watcher because rendering, not marking, is the delivery of record for an already-scheduled fiber; no cache can serve evaluation #1 (memo died with its pass). Matches Required.
residual risk: PF-2 regression; T-PF2. Note: the *first* write cost one no-op render (documented over-delivery; §11 prices it).
```

### C6: lane attribution under grouped notification — HANDLED

```
1 | batch(() => { a.set(1); … }) | library batch() defers only core-effect flushes; watcher delivery is per-write synchronous (never grouped) — stated: implicit grouping of deliveries does not exist in this design
2 | a.set(1) | S4 in the event's context → token U (urgent); walk delivers W_a⟵setState@U in this stack — React batches the setStates natively
3 | startTransition(() => b.set(2)) | S4 inside transition scope → requestUpdateLane returns transition lane → token T; walk delivers W_b⟵setState@T in the transition stack
4 | batch() closes | core effects flush once (newest… fully-retired world per §4.3 contract); no watcher work here
outcome: a's cone urgent, b's cone in T's lanes, one transition commit carries b's cone — the mechanism preserving per-write context is per-write synchronous delivery inside fork dispatch (D5), so context is by definition the writer's. Matches "Handle it".
residual risk: someone adding delivery coalescing later — DECISIONS D5 guard + C6 test asserting two lanes from one batch().
```

### C7: writes and reads during a yielded render pass

```
1 | k-pass P yields (time slice) | workLoop returns; executionContext render bit off (native)
2 | click handler: a.state read | getRenderContext() = undefined (PF-1: per-callstack, not wall-clock — S7 scar avoided) → hot(a) = newest ✓
3 | click handler: a.set(x) | S4: requestUpdateLane → discrete/sync token U; no throw (not a render callstack); q(a)+=[U:x]; walk delivers @U
4 | P resumes | getRenderContext() = {…k…} again; readInPass folds mask k: U ∉ mask → values identical to pre-yield; memo(P) intact; deterministic (queue append-only + fold filters by token)
5 | U ∉ P.mask → no PF-3 restart | P completes against its pinned world ✓
outcome: newest-world read in the gap, correctly classified write, undisturbed pinned pass. Matches Required.
residual risk: executionContext refactor upstream — PF-1 getter re-implemented; pinned by T-PF4.
```

### C8: equality drops must not lose receipts

```
1 | T: a.set(1) | q(a) empty pre-write, but T is a live batch context — I7 rule implemented as: drop only if queue empty AND no live batch minting needed; a transition write always logs → q(a)=[T:1]
2 | U: a.set(1) (equal to newest) | queue non-empty → APPEND unconditionally (I7): q(a)=[T:1, U:1]
3 | U pass mask={U} | fold: base 0 → skip T → U:1 = 1 ✓ U's world shows 1
4 | (truncation not exposed — C17) if T never commits, T still folds at retire (D2): base=1 either way ✓
5 | two overlapping transitions same value | q=[T1:1, T2:1]: each pass folds its own token → both show 1; commits fold to 1; no drop occurred ✓
outcome: equality moved to fold/notify time (render output equality), never write time with history. Matches Required.
residual risk: someone "optimizing" equal writes with pending history — pinned by C8 unit test + I7 in DECISIONS-adjacent notes.
```

### C9: mount mid-transition (existing and fresh nodes)

```
1 | k writes atoms; k-pass P renders a subtree that mounts component M
2 | (a) M reads existing computed c | readInPass: memo(P)[c] ?? evaluate under P.mask → k-world value on FIRST render ✓ (no canonical leak: render reads never consult hot/committed)
3 | (b) M's useComputed creates fresh node n | evaluation runs immediately in captured context (P.mask): folds k-world atoms ✓ — a fresh node needs no marks/edges/shadow because world routing is by mask at read time, not by per-node state (the "eager world-routing for fresh nodes" mechanism the case asks to name)
4 | subscribe at effect phase + M12 fixup | node n tagged adoption-pending in gateSet (live token k) until commit-time edge adoption (§7.3) at k's commit
5 | StrictMode replay of P's render | same passSerial → same memo → identical values; discarded pass drops memo (C14 compatible)
outcome: both reads resolve in the pass's world on first render; no double render. Matches Required.
residual risk: fresh-node evaluation accidentally re-tracking canonical edges from a deferred world — forbidden by §6.2; pinned by an edge-purity unit test (evaluate in fake pass, assert graph unchanged).
```

### C10: late subscription joins the pending batch

```
1 | k: a.set(1) | walk: W not mounted yet → no delivery
2 | urgent mount pass (mask cm only): W renders c = committed value v₀; W.lastRendered=v₀
3 | layout effect: M12 fixup | live deferred tokens: {k}; readInWorld(c, cm∪{k}) = v₁ ≠ v₀ → S8 runInBatch(k, setState(W)) → true → W's correction is IN k's lanes; gateSet.add(c, {k}) (mount-gap belt)
4 | k's pass renders W: fold(cm∪{k}) = v₁; gate validates; ONE commit carries k's updates + W's correction ✓
5 | why not a fresh startTransition: it would mint T′ with its OWN lanes → React may commit k without T′ → a frame where k's world is on screen but W shows v₀ — torn; runInBatch entangles instead (PF-7)
6 | race: k retired before layout effect | S8 returns false → urgent setState → layout-effect-scheduled sync re-render before paint (pre-paint correction) ✓
outcome: exactly one commit with both, via lane-scoped scheduling. Matches Required.
residual risk: S8 lane-join semantics across React's transition entanglement changes — pinned by T-RIB1.
```

### C11: multiple roots — DECLARED SCOPE: full spanning support

```
1 | k writes a; watchers W_A (root A), W_B (root B) | walk delivers setState@k to both → React marks A and B with k's lanes natively (spanning set = roots with k-lane work, discovered by delivery, tracked by fork per-root as pendingLanes)
2 | A's k-pass → gate → onCommit(A, {k}) | cm(A)+={k}; k NOT retired (B still observing — PF-5); committed view (a, A) advances to k's value
3 | A's later urgent pass U | mask = cm(A)∪{U} ∋ k → A keeps including k: A never contradicts its own committed DOM ✓
4 | A's passive effects after commit | useSignalEffect(A) reads readCommitted(·, A): includes k ✓ even though token live
5 | B renders/commits k later | cm(B)+={k} → all observing roots committed → onRetire(k) exactly once → base advance
6 | skew window (steps 2–5): a node re-tracked under A's committed class while cm(B) lags | gateSet skew tag (§7.2) → B's commits validate affected watchers until k fully retires
outcome: per-root committed masks (fork-native — commit is where the fork lives) make "the committed world" a per-root fold; no single global committed view exists to be wrong. Matches full-spanning Required.
residual risk: skew-tag completeness (the enumerated windows §7.2) — pinned by the react-concurrent-store harness extended with a two-root scenario + fuzz oracle gate-find classification.
```

### C12: store-only transitions persist

```
1 | startTransition(() => a.set(5)), no subscribers | S4: token k; q(a)=[k:5]; walk: no watchers → no React work anywhere
2 | transition scope ends; no root has k-lane work | fork closes k → onRetire(k, folded) — D2: retirement always folds → base(a)=5 ✓ hot already 5
3 | async action: startTransition(async () => { a.set(1); await io(); a.set(2) }) | writes append under the SAME token (fork's async-action context keeps the lane across awaits — native entanglement); k parked (PF-5) until the action settles
4 | settle → close → onRetire | fold in seq order: base=2; not before settle ✓
outcome: persistence never consults subscription (the S4 scar is structural here: fold-at-retire is unconditional). Matches Required.
residual risk: async-action context propagation across awaits in the fork — pinned by T-RET2.
```

### C13: counter/world-id lifecycle soundness (and C1-T6)

Counters, their consumers, and their guards (I8 — every reset paired):

```
counter | referenced by | reuse guard
token serial (32-bit, monotonic) | ops (folded at retire), dedup maps (pruned at onRetire), gateSet tags (cleared per token) | never reused while live; all retained references pruned on the retire edge — forced-wrap test mints 2^32-k tokens with pruning asserts
slot (5-bit) + slotGen (32-bit) | watcher clock records, clock arrays | slot recycles only at zero unswept entries (I10); slotGen bump on recycle; records compare (slot, gen, clock) — gen mismatch ⇒ treat as unobserved (validate) — forced gen-wrap test with masked counter
passSerial (32-bit) | per-pass memo tables | memo dropped at onPassEnd (lifetime ≤ pass); serial reuse after wrap cannot validate a dropped table — forced-wrap test
worldId | thenable cache | retired with member tokens (PF-6); cache pruned on retire — forced reuse test asserts prune-before-remint
global seq (fold order) | ops | ops pruned at base advance; seq compared only among live ops of one queue — wrap horizon test with forced small counter
episode quiescence | all of the above | full retirement of all tokens = quiescent point; forced-small-counter test drives a full episode, then a new one, asserting no stale mark/record validates (the C13 schedule verbatim)
outcome: every structure that retains a counter value is pruned on the same edge that ends the counter's meaning, or carries a generation. Matches Required.
residual risk: a NEW retained structure added without a guard — CI includes a schema-sweep (E-inherited apparatus) listing every counter-bearing column and its guard.
```

### C14: StrictMode and replayed renders

```
1 | double-invoked render | reads go through memo(passSerial) — idempotent; no canonical edge writes from deferred worlds (§6.2) and committed-class evals are idempotent re-tracks (same read set) → no observable graph mutation across replay/discard
2 | render-phase write | S4's onWrite checks getRenderContext() ≠ undefined at the WRITE callstack → throw (native truth; a yield-gap handler write correctly does NOT throw — C7)
3 | double-mounted effects | watcher subscribe/unsubscribe/resubscribe nets to one via R1's microtask-debounced observed-lifecycle (flap damping); atom `effect` sees one 0→1
4 | thenable identity across replays | keyed (node, worldId, position) — replay in the same pass/world hits the same entry → React use() sees a stable thenable, no re-suspend loop
outcome: purity by construction (Construction A: no durable writes from passes) + native render detection. Matches Required.
residual risk: adoption (§7.3) runs at commit — commits don't replay; discarded passes never adopt — pinned by StrictMode suite run of the whole conformance battery.
```

### C15: Suspense across worlds

```
1 | k makes c suspend | k-pass P (worldId w_k): eval c → ctx.use(thenable): cache miss (c, w_k, pos0) → mint, store; evaluation aborts with suspension sentinel; W suspends via React use protocol
2 | component M mounts mid-transition reading c | same pass or later k-pass: same worldId w_k → SAME thenable (positional, args-equal) → consistent suspension — the react-concurrent-store known bug is a passing test because the world key is fork-minted, not pass-scoped
3 | promise settles | retry pass P′ (new passSerial, same token set ⇒ same w_k — PF-6): eval c fresh: folds current k-world atoms; ctx.use pos0 args equal → settled thenable → value; render completes
4 | canonical world | never evaluated c under w_k; committed-class cache holds the last committed value/sentinel — no suspension leak
5 | k commits with settled value; onRetire(k) → w_k retired → cache pruned
6 | multi-batch pass key | worldId is minted per (root, token-SET): a {k1,k2} pass gets w_{12} ≠ w_k1 — "a single token is not enough" answered; passSerial-alone re-fetch-forever avoided (PF-6 stability across retries); lifetime = until any member token retires
outcome: stable per-world identity with fork-owned lifetime. Matches Required (R6 including the mount-mid-transition-suspending case).
residual risk: args-equality policy for positional reuse (documented: reference/shallow configurable) — pinned by the 14-scenario harness + its known-bug case.
```

### C16: effects observe committed state only

```
1 | D: a.set(1) applied (hot=1, q(a)=[D:1]), D not committed
2 | unrelated k commits on root r → onCommit(r,{k}) → passive effects flush | useSignalEffect reads readCommitted(a, r): fold(retired ∪ cm(r)) — D ∉ cm(r) → sees a=0 ✓ (hot slot is not consulted by effect reads)
3 | D commits → onCommit(r,{D}) | committed view (a,r) advances to 1; committed-topology walk (edges are committed-class — fresh per §6.2) marks effects reading a → effect re-runs, sees 1 ✓
4 | core effect() contract (stated per case allowance) | React mode: fully-retired world — sees a=1 only after onRetire(D); DIRECT mode: immediate. Walked: step 2's schedule for a core effect reads fold(retired)=0; after D retires, re-run sees 1.
outcome: applied-but-uncommitted writes are invisible to effects by mask arithmetic, not by discipline. Matches Required.
residual risk: committed-view advance ordering vs effect flush — pinned by a reconciler test asserting C-5 fires before passive-effect flush.
```

### C17: optimistic rollback / truncation

Not exposed. This design deletes the truncation surface: React batches
themselves never truncate, SharedQueue ops are append-only, and retirement
always folds (D2). Optimistic UI patterns compose from transitions +
reducer semantics (React's own `useOptimistic` shape can be built on R3
atoms whose pending ops fold away naturally at retire). Stated per the
case's own escape clause; no walk required beyond: no API exists whose
absence this case tests.

---

## 11. Performance: numbers against the gate classes

Requirement gate classes (requirements.md P1–P4), with this design's cost
shape and status. UNMEASURED costs are spike proposals (SQ-*), never
asserted.

| gate | mechanism cost shape | number / status |
|---|---|---|
| P2 tier-0 pure-core | donor arena kernel unmodified; mode latch is a prototype swap, DIRECT executes zero concurrency instructions | measured: deep 0.90×, broad 0.84–0.88×, diamond 0.89×, reads 0.74–0.87×, create 0.96×; 179/179 with exact pull counts [ARENA][SYNTH §18.2] — inherited |
| P3 React-mounted-but-quiet ≤2% | tracked read: one getRenderContext per evaluation + queueId-undefined branch per atom (no queue until first write); hot slot = plain field | **SPIKE SQ-1**: donor kernel + branch, tier-0; gate ≤2% |
| P1 re-render ≤10% of useState | render read = memo probe + fold over the atom's live ops — isomorphic to updateReducer's own per-render queue processing; setState delivery identical to userland | **SPIKE SQ-2**: differential microbench (SharedQueue-driven re-render vs useState) across 1/10/100 pending ops; gate ≤10% |
| P1 10k-subscription mount ≤15% | per-watcher record + arena node; no fork calls until first write | **SPIKE SQ-2b** same harness |
| write (React mode) ≤2× DIRECT [G-6 class] | dispatch (classify+append) + walk (donor propagate + per-token dedup int compare) + setStates | **SPIKE SQ-3**; the walk carries one extra int compare per visited node vs DIRECT — bounded, must measure |
| gate overhead per commit | fast-out: 2 null checks + 1 branch (no windows). Sweep: O(tagged nodes) folds, memo-shared | **SPIKE SQ-4**: kairo-style write storms under held-open transition; gate find-rate asserted ≈0 in normal flows |
| P4 zero steady-state alloc | folds allocate nothing (apply into locals); memo tables ring-reused per passSerial; walk uses persistent scratch stacks (donor); setState allocates React update objects — parity with useState (React allocates the same) | heapUsed + plane bytes reported side by side (inherited harness) |
| held-open transition (O9/G-8 class) | every k-pass re-evaluates the k-dirty cone (memo-shared within pass; no durable world caches to hand hot reads) | **SPIKE SQ-4** covers; documented cost of the no-durable-cache bet |
| equal-write over-delivery (§5.2/C5) | one no-op component render per (watcher, token) on suppressed-value writes; DIRECT/core cutoffs unaffected (P2 exact pull counts hold) | documented behavior, not a gate breach; optional selector-grain isEqual noted as v2 knob |

Bytecode budgets: fold, dispatch fast path, walk step, memo probe each get
a CI budget row (inherited apparatus, D6); the fold hot loop targets the
donor's inline-safe size (≤168-byte class per research-facts inlining
data).

---

## 12. The maximalist variant: explored, NOT viable (the stance's license)

**Maximal fork-native** = React also owns notification and dependency
knowledge: atom reads register into fiber.dependencies-style per-fiber
lists (flattened through computeds), writes schedule fibers via a
reconciler-maintained reverse index, no library graph at all.

Killing schedules:

1. **C5/P1 render storm (cutoff loss).** `c = a*0 + b` with 10k watchers;
   `a.set(1)` in any batch. Flattened per-fiber read sets contain {a, b}
   for all 10k fibers; there is no computed-grain node at which an
   equality cutoff can stop propagation, so 10k fibers schedule and render
   for a value that cannot change. alien-class semantics (and the 179-case
   suite's pull-count discipline) require the cutoff; useState parity
   offers no rescue because React's own eager-state bailout exists only
   for the first update on an idle queue. Order-of-magnitude regression on
   broad shapes; unfixable without reintroducing a node between atom and
   fiber — i.e., the library graph.
2. **R13 has no fiber.** Core `effect()`, `computed` at module scope, and
   the benchmark adapter run with no React and no fibers; a
   reconciler-owned reverse index has no home and no processor for them.
   A shadow "effect fiber" per computed re-invents the library graph
   inside the reconciler — worst of both.
3. **Creation benchmarks.** A hidden fiber (or fiber-shaped record) per
   computed costs ~hundreds of bytes and pointer-web allocation per node;
   the donor's create score (0.96× alien) has no headroom for it (P2/P4).

Killed, with schedules. The viable retreat is this design: values/worlds/
commit-safety in the fork, graph in the library. Fallback line if the
centerpiece sours (§9.7): SharedQueue moves library-side behind the same
seam — the protocol shape (tokens, context getters, gate, runInBatch,
retirement) survives, so this design degrades gracefully rather than dying.

---

## 13. OPEN.md answers (stance-touched) and DECISIONS compliance

- **O1** (where does per-world dependency knowledge live): nowhere,
  durably. Transient per-pass read sets + committed-class canonical edges
  + the commit gate replace durable per-world topology. This is the
  fourth point of the axis ("fork-native") made concrete.
- **O2** (host-callback tax): not touched — this design uses the donor
  closed kernel directly, no host-protocol indirection; SP1 is orthogonal.
- **O4** (React-owned queues): answered in full — queue lives fork-side,
  keyed per atom; processed by `fold` at read edges, by base-advance at
  retire; non-React reads served by hot slot + per-root committed views;
  rebase cost = §9.4/§9.5 (2 new files, ~65 touched lines, drill answer
  "library: nothing"); the maximal form is killed in §12.
- **O5** (yield/resume shape): per-callstack query (S9) over React's
  existing executionContext + wip lanes — zero new fork state, one call
  per evaluation (not per read); listener edges rejected as sampled-state
  (charter goal 2).
- **O6** (grouped-notification lanes): per-write synchronous delivery
  inside fork dispatch; no implicit grouping exists (C6 walk).
- **O7** (per-root committed views): fork-owned per-root masks (M2),
  consumed by readCommitted/committed views and the effect flush filter
  (C11/C16 walks).
- **O8** (suspense world key): fork-minted worldId per (root, token-set),
  stable across restarts/retries, retired with member tokens (C15).
- **O9** (held-open hot reads): no world memos exist; per-pass re-eval,
  priced at SQ-4; slot write clocks are used only as gate/fixup filters,
  not value-cache validators.
- **O10** (coalescing): only the empty-queue equal-set drop (I7-safe);
  no mid-history coalescing — its mechanism slot isn't earned here.

DECISIONS: D1 ✓ (M13 latch, monotonic; always-log = SharedQueue append,
urgent included). D2 ✓ (retire always folds — C12). D3 ✓ (fold IS the
clause; differential-tested). D4 ✓ (donor kernel closed; React-mode walk
adds per-node int stamps in spare record fields — no per-link state, and
DIRECT walks untouched; budgets CI-enforced). D5 ✓ (M8). D6 ✓ (inherited
wholesale, §11/§14). D7 ✓ (this design is the charter's wildcard clause,
taken seriously and priced).

---

## 14. Known gaps, residual risks, and the fork's test list

**Known gaps (declared, none hidden):**

1. Four unmeasured cost gates (SQ-1..4, §11). Any one failing forces the
   named retreats: SQ-2 fail → library-side queue with per-atom op arrays
   (same seam); SQ-4 fail → narrow the gate's fast-out further or add a
   canonical-cone prefilter; SQ-1 fail → per-atom mode bit instead of
   getter swap.
2. Equal-write over-delivery (one no-op render per watcher per token) is a
   documented parity divergence from alien's effect-suppression — correct,
   priced, with a v2 selector-equality knob sketched (§11).
3. Core `effect()` in React mode lags to the fully-retired world (§4.3) —
   a documented contract choice; apps needing committed-per-root semantics
   use `useSignalEffect`.
4. gateSet tag completeness (§7.2) is an enumerated-window argument, not a
   single induction; it is fuzz-oracled (every gate find must classify)
   and is the design's most watch-listed seam. A found unclassifiable gate
   find = a delivery-layer bug class this design must patch in M8, not in
   the gate.
5. §7.3 adoption skips multi-batch passes; such nodes stay gate-resident
   until a canonical evaluation — correct but costs gate sweeps while they
   persist.

**Fork reconciler test list (deliverable, runs on every rebase):** T-PF1
(context getter truth incl. yield gaps), T-PF2 (fresh re-render per pass
until commit), T-PF3 (write-in-mask forces re-pass, both windows), T-PF4
(yield-gap dispatch classification), T-SQ1 (useReducer differential, C3
battery), T-SQ2 (fold vs hook lane-filter property fuzz), T-RET1/2/3
(retire exactly-once; async parking; per-root masks + spanning retire),
T-WID1 (worldId stability/retirement), T-RIB1 (runInBatch join + retired
false), T-GATE1 (gate blocks commit, correction loop bounded), T-C2
(flushSync end-to-end), T-VER1 (stock-React loud failure), plus the
react-concurrent-store 14-scenario harness and a two-root spanning
scenario, all driven through the compiled fork.

**Remaining product requirements, briefly:** R7: React's nested-update
limit covers watcher storms (gate corrections included); core-only cycles
use the donor kernel's evaluation-stack detection. R8: core writes-in-
computeds allowed acyclic behind `configure({forbidWritesInComputeds})`;
render-world always throws (C14 walk). R10: SSR serializes quiesced base
values; hydration constructs atoms from them; bridge latches at
hydrateRoot. R11: the reference tracing bar (synthesized §16 class) is
adopted unchanged — one slot check per site untraced; trace points ride
the existing seam callbacks (onWrite/onPassStart/onCommit) so tracing
needs no new fork surface. R9/C11: full spanning scope declared and
walked. `effectScope`: excluded v1 (does not earn its slot; watchers and
React lifecycles cover the product cases; core users compose disposal).

---

*End of spec. 13 mechanisms; 16 seam touch points; all C1–C17 walked
(C17 resolved by deleting the surface per its own clause); 4 pre-registered
spikes; maximal variant killed with schedules.*
