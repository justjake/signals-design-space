# Appendix B editorial flags — model-level findings

Flags 3, 4, 5, 7 are checkable at model level (spec/cosignal-v1.md,
appendix B). Each has a targeted test in `tests/flags.spec.ts`; flag 5's
soundness half is additionally asserted inside the model on **every** mount
fixup (battery, scars, and every fuzz seed exercise it). Per the task rules,
discrepancies are recorded here and in code comments — the spec text was not
edited.

## Flag 3 — write-set closure at commit (ActionScope late writes)

**Checked, consistent.** The surviving late-write surface behaves coherently
in the model: a scope write on a pending, already-committed token is visible
to that root's committed world immediately (membership clause), the
value-blind delivery in the batch's own lanes is the documented corrective,
and the slot lifecycle composes cleanly (per-root rows clear at retirement,
strictly before release — invariant-checked on every step). No discrepancy
with the editorial resolution itself, **but** this surface composes with
flag 5 into finding 5.3 below: the late write is invisible to every fixup
fast-out conjunct.

## Flag 4 — pass-world membership pin cap

**Checked, correct.** The editorial clause (slot ∈ capturedCommitted ∧
seq ≤ pin) is exactly what keeps a yielded pass's world from drifting when a
committed-member (live, e.g. parked-action) token writes after the pass
pinned. The cap loses nothing: the write is committed-visible at now and at
every later pin. Removing the cap in the model makes `passValue` change
across a yield — precisely the drift the spec forbids ("The pass observes
included-batch writes only up to its pin, forever, across yields").

## Flag 5 — fixup fast-out conjunct set

Three findings. The four conjuncts as written are **not sufficient on their
own**; they are sound only together with the per-token corrective loop and a
commit-legality fact, and one spec walk's claim is wrong.

1. **Case 9 row 8's parenthetical is wrong.** "(if k stays live instead, the
   loop's runInBatch is the corrector and the compare comes out equal — one
   bounded eval, no false urgent)": per §4.2 the commit's own table update
   precedes layout, so committed-for-root includes k's post-pin write via the
   membership clause and w_fx's **uncapped committed clause folds it** — the
   compare fires. The fired correction is value-TRUE (committed truth really
   moved), so behavior is sound; the walk's "comes out equal / no false
   urgent" claim is not. (Pinned in `battery.spec.ts` case 9 (d′).)

2. **Late-interned mask slots evade the clock conjunct** (fuzz seed 29,
   shrunk to 5 ops). A mask token whose *first* write lands mid-pass interned
   its slot after mask capture, so `∀s ∈ w_r.mask: wc[s] ≤ pin` is vacuously
   true for it. If that token then retires at the commit (case 9 row 8's own
   shape, minus the pre-pin write), v_fx moves under a held fast-out with no
   live token left for the corrective loop to cover. The model adds a
   commit-time check over the committing pass's mask **tokens** (their write
   clocks in sequence units); the spec's conjunct quantifying over captured
   mask *slots* is unsound for this population.

3. **The flag-3 surface is invisible to every conjunct** (fuzz seed 173,
   shrunk to 9 ops). A live token already committed into the root takes a
   write after an unrelated same-root pass pinned: baseline.cas is old (no
   committed-side advance), the root commit generation is unchanged, and the
   mask clocks are silent (the token is in the *committed* set, not the
   mask). v_fx then diverges from v_r under a held fast-out. It is not a
   tear **only because** the per-token corrective loop scheduled that
   token's runInBatch setState. The population argument in §5.10 should
   state the loop as a premise; the sound invariant — asserted by the model
   on every mount — is: *fast-out divergence must be exactly
   corrective-covered*.

Related legality fact the fast-out depends on (fuzz seed 97): a retirement
folded **inside** a commit must belong to a batch that commit rendered
(mask member). A foreign batch retiring inside another pass's commit lands
after the baseline capture and breaks the fast-out permanently; under fork
tests 22/25 that schedule is unreachable (a foreign batch retires at its own
closure — the mid-yield shape of case 9 (c)). The model enforces this as a
schedule-legality rule in `passEnd`.

## Flag 7 — backstop without the pass flag

**Checked, correct (flag-free is sound).** With receipts denormalizing their
slot at mint, a forced (backstop) release of a mask-retained retired slot
changes no pinned fold: the retained pass's world is byte-identical before
and after the backstop, and the new tenant's world folds both tenants'
history in global-sequence order with nothing double-applied. The model has
no touched-word dirt to preserve (it recomputes routing), so the
keep-the-dirt half of the resolution is vacuously satisfied here; the
receipt-level half — the only part visible in observables — holds under
fuzzing and the targeted corner test (`flags.spec.ts`, `scars.spec.ts`
S29b).
