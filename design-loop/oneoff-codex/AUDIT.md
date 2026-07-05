# ROOT-CELL verification and adversarial audit

Date: 2026-07-04

This file records what was actually checked after writing `DESIGN.md`. It is
intentionally stricter than the design's prose: an executable abstraction is
evidence for the algorithm it contains, not evidence that the React fork can
implement it.

## Commands run

```sh
node --test design-loop/oneoff-codex/model.test.mjs
```

Result: 13/13 tests passed. Covered:

- C2 default-lane exclusion for both atom and computed;
- C3's 4-not-3 rebase and the plain-set overwrite case;
- a small exhaustive matrix of two operations, two lanes, and a partial then
  complete render;
- C8 equal writes retained in separate lanes;
- post-pin reads, including first read after the write;
- same-lane pending-only dependency delivery;
- an older excluded write discovered after its write-time notification;
- a subset pass whose dependency differs even though base and newest agree;
- late-mount retroactive scheduling;
- pass-memo leaf replay to a second consumer;
- store-only dirty-cell commit;
- render write rejection before newest or queue state changes.

```sh
env FRAMEWORK=arena pnpm -C harness conformance
```

Result: 179/179 tests passed. This re-verifies the proposed K0 donor in the
current checkout. It says nothing about the unimplemented React path.

```sh
git ls-remote https://github.com/facebook/react.git refs/heads/main
```

Result: React main was
`e71a6393e66b0d2add46ba2b2c5db563a0563828`. Source inspection at that commit
confirmed:

- class queues use current/work-in-progress double buffering and persistent
  update lists;
- hook and class queue processors preserve insertion order, retain the state
  before the first skipped update, and clone later included updates with a
  committed/no-lane marker for replay;
- context reads attach dependencies to the currently rendering Fiber after
  resetting the work-in-progress dependency list;
- context propagation marks matching consumer lanes and ancestor child lanes;
- scheduling an update on the active root records interleaved/render-phase
  lanes, but ROOT-CELL's exact post-pin and detached-cell behavior is new fork
  work and remains unverified.

Official React documentation was also checked for the scope statement about
async actions: a setter after `await` currently needs another
`startTransition`. This supports the statement that ROOT-CELL matches React's
current public behavior; it does not make ROOT-CELL satisfy the seed's stronger
automatic-attribution requirement.

## Counterexample pass and resulting repairs

### 1. An intervening commit could roll a resumed pass backward

Attack: pass P pins, an urgent root-cell update commits, then P resumes and
tries to install its older cell work-in-progress state.

Original draft gap: only included-lane post-pin writes explicitly invalidated
P. That did not prevent old queue state from overwriting a newer root commit.

Repair in `DESIGN.md`: every pass captures `root.commitVersion`; root-cell
install is a CAS. Any intervening commit synchronously invalidates/discards the
older pass before it resumes or commits. This is now fork invariant 4 and is
still unverified in React.

### 2. A cell can become dirty after pass start and be read for the first time

Attack: P starts while cell y is quiet, yields, U writes y, then P first reads
y. Eagerly snapshotting only the cells dirty at pass start does not cover y.

Repair: first read lazily processes y from current plus pending operations at
or below P's pin. Post-pin operations stay pending. The model's post-pin test
checks both an already-read cell and a first-read cell.

### 3. A dependency can be discovered after an excluded write

Attack: T1 changes a branch; T2 writes the newly selected leaf before T1's
pass evaluates it. Write-time delivery cannot reach the component.

Repair: dependency installation scans both the base queue and pending queue,
not merely `seq > pin`. It schedules every non-committed lane excluded from the
pass. The model checks this exact order and the late-mount form.

### 4. A shared computed memo can hide leaves from its second consumer

Attack: component A evaluates c and records leaves; component B hits c's pass
memo and performs no atom reads. A later leaf write schedules A only.

Repair: every memo hit replays its flattened leaves through the current
Fiber's dependency recorder. The model checks that a later write schedules
both WIP consumers.

### 5. A dynamically tracked React effect would over-execute

Attack: flattening a computed to atom leaves is safe for rendering because an
extra render is invisible. It is not safe for `useSignalEffect`: a leaf may
change while the computed's equality cutoff holds, and rerunning user effect
code is observable.

Repair: the draft's fifth mechanism was deleted. v1 supports ordinary React
effects over values returned by `useSignal`; the seed's auto-tracked
`useSignalEffect` is an explicit omission.

### 6. Computed equality has no shared render-world cache

Attack: pass-local recomputation can produce a new but `isEqual` result on
each render.

Repair: `useSignal`/`useComputed` may retain the last committed hook result and
return that reference on equality. Delivery remains value-blind. The design
also states that values declared equal are semantically interchangeable and
makes no shared computed-cache claim. Hidden/Offscreen behavior remains a fork
test obligation.

### 7. Atom observation callbacks need commit ownership

Attack: counting WIP reads as observation can start an Atom's external effect
for a pass that later discards; never counting Fiber consumers omits the
required 0→1 lifecycle.

Repair: M3 invokes the Atom observed-count callback only when Fiber
dependencies commit/unmount. K0 and committed Fiber counts merge in the
library; setup/cleanup is microtask-damped. Suspense/Offscreen/error cleanup is
unverified.

## Schedules re-walked without a new issue

- BASE and HEAD agree while a subset differs: there is no BASE/HEAD graph;
  the pass queue computes the subset and the Fiber records its actual leaves.
- A store-only transition has no subscribers: enqueue marks root-cell work
  independently of the reverse list. The abstract model commits it; the fork
  path remains a required spike.
- Equal newest values in overlapping lanes: queue entries are never dropped in
  React mode.
- A write happens between render and commit: committed and WIP dependencies are
  both reachable; same/included-lane post-pin work must invalidate pre-commit.
- StrictMode/error abandonment: all render discoveries are WIP state. The
  design no longer allocates global nodes during render. Actual Fiber cleanup
  is not yet proven.
- Counter collision: the design has one non-reset safe-integer sequence and a
  hard terminal error; no finite-width generation or slot identity is reused.

## Claims deliberately not made

- No ROOT-CELL benchmark number exists.
- The fork size and rebase cost are unknown.
- Detached cells are not present in stock React.
- Full seed compliance is not claimed: multi-root, mutable reducer identity,
  automatic post-`await` attribution, `ctx.previous`, computed promise
  factories, dynamically tracked `useSignalEffect`, tracing, and RSC are out of
  scope.
- The model does not prove Suspense, Offscreen/Activity, hydration, or Fiber
  lifecycle behavior.

## Current verdict

ROOT-CELL is internally smaller than the receipt/K1 designs because React has
one canonical representation for React-visible state and dependencies. It is
also a higher-risk fork. The architecture is worth a narrow steps-1-to-4
prototype; it is not ready for broad implementation or performance claims.
