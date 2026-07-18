# Adversarial correctness review — round-05 surgical-a

## Findings

### 1. BLOCKER — local fix: commit-entry fast-out tears an Offscreen reveal

The §3.3 claim that a watcher not rendered by the committing pass “fails conjunct 1” has no construction and is false. React-only hiding and revealing does not advance `cas`.

```text
setup | atom a=0; visible sibling S and hidden Offscreen watcher W
      | W last rendered a=0 under w_r={mask:∅, pin:p, lockView:L}
      | hiding disconnected W's subscription; no later committed signal motion

1 | deferred T writes a=1 and schedules the Offscreen reveal
  | receipt seq > p; W is unsubscribed, so delivery cannot reach it

2 | T render
  | S renders a=1; React reuses W's hidden completed subtree without invoking W
  | W therefore retains its old w_r and DOM output 0

3 | commit entry
  | commitBaseline={cas:c, lockView:L}, with c ≤ p
  | capture occurs before T's fold and lock-in

4 | commit body
  | T folds/retires; committed a becomes 1; cas advances; T is no longer live

5 | W's reveal layout fixup
  | the first fast-out may fail while T's touched bit remains
  | per-token loop skips retired T
  | commitBaseline.cas ≤ p is true
  | commitBaseline.lockViewId == L is true
  | w_r.mask is empty, so the wc conjunct is vacuous
  | fixup returns without evaluating w_fx

6 | paint
  | S shows 1 while newly revealed W shows 0
  | T is retired and W missed its delivery, so no later correction is guaranteed
```

This is a torn committed frame. The fast-out must additionally prove that the watcher was rendered by the committing pass—likely through the already-mentioned `lastRenderPassId`—and otherwise perform the `w_fx` comparison.

### 2. BLOCKER — architectural: R8’s counter-horizon reserve has no finite construction

VH-R8 asserts that horizon `H` has slack for “one atomic extent’s mints,” but a synchronous React commit can publish arbitrarily many hooks. No bound, reservation operation, or overflow behavior is defined.

```text
setup | forced-small globalSeq with finite remaining reserve S
      | root B has a yielded pass at pin p, with W1 already rendered under evaluator f0
      | root A will commit S+1 unrelated evaluator publications, then promote n: f0→f1

1 | root A enters its synchronous commit
  | the boundary check admits the operation; no renumber may occur inside it

2 | the unrelated F9 publications consume more than S sequence mints
  | globalSeq crosses its horizon and wraps/collides before n's promotion

3 | n is promoted with numeric q ≤ p
  | P2′ tests oldestLivePin < q and incorrectly finds false
  | no touched bit or synthetic retention entry is installed for n

4 | NEWEST traffic recomputes n under f1 and restores CT(n)

5 | root B resumes
  | W2 fast-paths through clean K0 and reads f1 while W1 contains f0

6 | root B commits
  | one frame contains f0 and f1
```

Throwing when the reserve is exhausted would instead crash an ordinary large commit. The design needs an explicit maximum mint count with enforced pre-reservation, a preflight count, or a counter scheme that remains ordered across an in-progress extent.

### 3. BLOCKER — local specification fix: the review artifact omits its normative base and required walks

The protocol forbids reading other round files, while this document replaces the required mechanisms and traces with “carries verbatim.” Consequently, the artifact admits incorrect implementations of unchanged cases.

```text
setup | C3: a=1; deferred T queues +1; urgent U queues ×2

1 | U renders excluding T
  | U computes 2 and commits

2 | U's operation is compacted into base=2
  | this file does not define the retained rebase record or compaction invariant

3 | T later folds its still-pending +1 over base=2
  | result is 3

required outcome | replay T then the cloned U operation over the pre-batch base: (1+1)*2=4
```

Nothing present in this artifact rules out step 2; that rule exists only in the inaccessible champion text. The same problem affects most battery cases, lifecycle rows, and fork facts, so the design does not meet the requirement that every case be walked mechanism-by-mechanism. Inline the complete normative base and actual traces into the reviewable artifact.

### 4. HIGH — local fix: synthetic version entries lack slot-incarnation lifecycle identity

P2′ makes a superseded version an unswept entry “of slot s,” but the declared record carries only `{fn, deps, stamp, promotedAtSeq, retiredSeq}`. No slot, slot generation, swept flag, or side-entry lifecycle is named, despite §9 claiming only `retiredSeq` is new.

```text
setup | old pass P pins before promotion q
      | q's superseded version R is counted against numerical slot s

1 | the associated token retires while P remains pinned
  | R prevents ordinary recycling

2 | saturation force-clears s
  | P becomes world-path-only; numerical slot s is recycled

3 | a new token u interns the same numerical slot s
  | u writes a=1, marks computed c, and owns the new incarnation's unswept count

4 | P ends and R is reclaimed
  | the listed state cannot identify whether R belongs to old-s or current-s

5 | if reclamation decrements current unswept[s]
  | u's count can reach zero and clear c's bit
  | NEWEST recomputes c=1; flushSync excluding u can then read a=0 beside fast-path c=1

alternative | if reclamation never decrements
            | repeated promotions leak slot counts and eventually exhaust all 31 slots
```

The abstract “counts as” relation requires concrete state. Add a cold slot-incarnation handle or an explicitly swept side entry, and specify its normal-reclaim, force-clear, and reuse transitions.

## Verified held

- **C1-X6 with an ordinary open foreign pass:** once P2′ installs the bit and synthetic entry, a NEWEST recomputation cannot wash out routing; the resumed pre-`q` pass reaches the pin-resolved evaluator.
- **K2a foreign retirement before commit entry:** the captured `cas` is greater than the watcher’s pin, so the repaired predicate reaches the `w_fx` comparison.
- **K2b for a watcher rendered by the committing pass:** an included slot with `wc[s] > pin` defeats the fast-out and exposes the post-pin retired write.
- **Future-pass evaluator visibility:** absent counter reuse, monotone pin minting ensures a pass started after `q` cannot request the superseded evaluator.
- **Install-to-mark ordering:** F9 publication and P2′ marking occur within a synchronous commit, so no yield-gap NEWEST recomputation can interleave between them.

## Verdict

The design is repairable, but it is not implementation-ready. The Offscreen schedule produces a concrete torn commit, while the unbounded mint extent and undefined synthetic-entry reincarnation leave lifecycle correctness unsound. After repairing those mechanisms, the complete normative base and acceptance walks must be present in this artifact before implementation can be judged.

