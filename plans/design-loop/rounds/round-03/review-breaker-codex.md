# Adversarial correctness review — Round 3 breaker design

## Findings

### 1. Reducer publication can permanently diverge K0, tape truth, and the committed tree

**Severity:** BLOCKER  
**Repair class:** architectural

**Schedule A — stale NEWEST value**

Setup: `state=0`; committed reducer `r0(_, A)=1`; replacement reducer `r1(_, A)=10`.

1. Deferred token T dispatches `A`. The receipt remains pending and K0 newest becomes `1` using `r0`.
2. An urgent React-only render excludes T, stages `r1`, and commits it through F9.
3. The design now says non-pass folds use committed `r1`, so replaying T’s tape yields `10`.
4. F9 only publishes the reducer and stamp. No specified mechanism replays pending receipts into K0 or delivers the resulting value change.
5. A handler reads NEWEST. Section 7 routes it directly through K0 and returns `1`; a later T-world fold returns `10`.

**Wrong observable:** the same logical newest world has two values.

**Schedule B — irreversible commit tear**

1. T’s pass stages `r1`, folds `A` to `10`, and renders `10`.
2. The protocol requires F3 retirement and F9 publication to finish before layout effects, but never orders F9 before retirement folding.
3. A permitted implementation retires T first, folds and compacts `A` under still-committed `r0`, and installs base `1`.
4. F9 then publishes `r1`, but the action receipt is already gone.

**Wrong observable:** the committed tree shows `10` while canonical state is permanently `1`.

Reducer publication must either be forbidden while receipts are pending, give receipts immutable reducer semantics, or atomically publish the reducer before replaying the pending tape into K0 and delivering any resulting change.

### 2. The empty-tape equality optimization can delete reducer actions

**Severity:** BLOCKER  
**Repair class:** local fix

Setup: base `0`; committed reducer `r0(s,"tick")=s`; replacement reducer `r1(s,"tick")=s+1`.

1. One transition queues the React state change that selects `r1`, then dispatches `"tick"` before rendering begins.
2. The receipt tape is empty. Evaluating the action with committed `r0` returns the base value.
3. Section 6.1 permits the equal operation to be dropped because the tape was empty.
4. The transition render stages `r1`, but there is no action left to replay.

**Wrong observable:** `useReducer` produces `1`, while `ReducerAtom` produces `0`, violating C3 parity.

The empty-history drop is valid only for operations whose meaning cannot vary by world. Reducer actions must always be retained whenever pass-staged reducers are supported.

### 3. Publishing new `useSignalEffect` dependencies never establishes their graph edges

**Severity:** BLOCKER  
**Repair class:** local fix

Setup: a committed effect with deps `[false]` reads atom `a`; with deps `[true]`, its replacement function reads atom `b`.

1. The initial committed callback runs and records only `a -> effect`.
2. A plain React state/prop update changes the deps to `[true]`; no signal is written.
3. The render stages the new function and F9 publishes it.
4. Root commit is a flush trigger, but section 10 says only effects reached by touched walks enter the queue. No touched walk occurred, so the new function is not evaluated and no `b -> effect` edge is installed.
5. Later `b.set(1)` walks K0∪K1. Since neither graph contains `b -> effect`, the effect is not enqueued.

**Wrong observable:** the committed effect never observes `b`, and future writes to its actual dependency are permanently missed.

F9 publication of a changed effect/deps record must enqueue a committed-state recheck and retrack its dependencies before host code can perform another write.

### 4. The global retirement stamp recreates resources whose root-visible content did not change

**Severity:** BLOCKER  
**Repair class:** architectural

Setup: T wrote `a=1`; root A already committed and locked T’s prefix, while T remains live because root B is pending. A separate suspended lineage K on root A reads `a` and creates thenable `q1` through `ctx.use(factory)`.

1. K’s prefix contains A’s T lock stamp; its fold of `a` is `1`.
2. Root B commits T, allowing T to retire.
3. Retirement replaces A’s lock-based visibility with retired visibility. A’s fold remains the same equality-stable `1`, but `retireVisStamp[a]` advances globally and A’s lock term disappears.
4. `q1` settles and React retries the same lineage K.
5. The positional capsule compares fingerprints, sees the new global retirement stamp, discards the now-settled `q1`, and invokes the factory to create `q2`.

**Wrong observable:** an unchanged root/world cannot consume its settled resource and suspends again. Repeating this with several already-A-locked tokens creates repeated side effects and can starve K indefinitely.

This directly breaks the identity/content construction: root-scoped lock stamps do not solve retirement over-invalidation. Resource identity needs a content-sensitive or world-relevant retirement certificate rather than one global per-atom stamp.

### 5. U1 is a silent misclassification, not a validly enforced support restriction

**Severity:** BLOCKER  
**Repair class:** architectural/contract

1. On a host without native `AsyncContext`, transformed action A calls an uncompiled library function and passes it an atom.
2. The library awaits internally. A remains parked.
3. An unrelated click runs and commits normally.
4. The library’s continuation calls raw `atom.set(2)`. It has no carrier, so F1 assigns a new default token.
5. That token retires before A settles, making `2` committed early.

**Wrong observable:** A’s supposedly atomic async action becomes externally visible before settlement, with no diagnostic.

The acceptance rules permit restrictions only when the forbidden pattern is reliably rejected. The design expressly admits that this write is indistinguishable from a legitimate carrierless write, while the manifest and boot probe still pass. Documenting it as unsupported therefore does not satisfy the contract; the public surface or carrier prerequisite must make this composition impossible or reliably fail it.

### 6. Mount fixup forces a second render for a token already represented by the mount

**Severity:** HIGH  
**Repair class:** local fix

1. Async token T writes `a=1`, mounts watcher W, and then remains parked across an await.
2. T’s pass renders W in a world including T; W correctly renders `1`.
3. Root A commits that pass, but T remains live because of the park reference.
4. Mount layout fixup sees T in `touchedSlots(W)`.
5. Its loop does not exclude tokens already fully represented by W’s rendered world, so it calls `runInBatch(T,setState(W))`.
6. F4 requires work inserted after completion to schedule new work, producing another T render and commit despite no intervening write.

**Wrong observable:** C9’s first-render/no-double-render requirement and C10’s exactly-one-commit requirement are violated.

Fixup must skip a token only when the rendered world included that exact slot generation through its complete rendered prefix; a post-pin write must still schedule correction. This can use the existing rendered pin and slot write clock without reverting to the equality-based late-join rule killed by S10.

## Verified held

- **C1 world-divergent dependencies:** after the first k-world evaluation records `a -> c` in K1, the later `a` write traverses K1 and produces a second k-lane delivery after W re-arms.
- **C2 flushSync exclusion:** always-logging plus the clean/current routing guard prevents a canonical computed cache from leaking into a Sync-only world.
- **C3 fixed-reducer arithmetic:** with an immutable reducer/evaluator, ordered receipt replay and prefix-only compaction produce the required `(1+1)*2=4`.
- **C4/C5 re-notification:** full per-write walks and watcher/slot pending bits survive already-stale K0 regions and an interposed render.
- **C7 yield gaps:** callstack-scoped slice enter/exit truth gives handlers NEWEST while preserving the resumed pass’s frozen pin.
- **C11 watermarks:** a commit excluding T cannot advance T’s watermark, so an unrelated urgent commit does not expose a post-await T receipt.
- **F9 winner selection:** hidden Offscreen publication, error-abandoned children, and stale alternates are distinguished by hook-grain publication IDs and generation checks; the remaining break is publication ordering/propagation, not winner selection.
- **Retro delivery and slot reuse:** token, slot, and watcher generations plus retained retro references prevent a queued T obligation from becoming an obligation for a recycled U slot.
- **Fixed-set quiescence termination:** for an actually fixed candidate set, two failures followed by exemption makes the stated rank decrease and eventually permits reset.
- **Rebase seam:** lane, Fiber, and update-queue representations remain behind F1–F9; none crosses into library types.

## Verdict

The design is not implementation-ready. Its two-kernel routing core is repairable, but reducer publication, effect retargeting, resource identity, and the undetectable carrier boundary make the current end-to-end contract architecturally unsound. A repair round must close these schedules and add them to the permanent battery before implementation begins.