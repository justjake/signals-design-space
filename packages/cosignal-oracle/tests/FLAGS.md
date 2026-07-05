# Subtle behavioral rules

Four rules of the behavioral contract that are easy to get wrong in an
engine implementation. Each was validated — and in one case corrected —
by fuzzing the reference model. Each has a targeted test in
`tests/flags.spec.ts`; the ids (**flag 3**, **flag 4**, **flag 5**,
**flag 7**) are stable identifiers shared with the test suite — the
numbering is historical, the prose here is self-contained. Rule *flag 5*'s
soundness half is additionally asserted inside the model on **every**
mount reconciliation, so the acceptance scenarios, the pinned regression
schedules, and every fuzz seed exercise it.

Background, briefly (defined fully in the package README): a **batch**
groups the writes of one UI update and is visible per **slot** (a
31-entry recycling identity table); a **render pass** freezes a **pin**
(a global timeline position) at start and captures a **mask** (the live
batches it renders); a **world** is a replay of the write **receipts**
that view may see; committing a pass **locks in** its still-live batches
to the root (membership in the root's committed view); **retirement**
makes a batch's writes permanent history.

## flag 3 — late writes from a committed, still-live batch

An async-action batch can be *committed into a root* (UI rendered from it
is on screen) while remaining *live* (it retires only when the action
settles). A scoped write the action makes after that commit lands on a
committed member — and behaves coherently:

- the write is visible to that root's committed world **immediately**,
  via membership — the root must keep agreeing with its own screen;
- the corrective is the ordinary value-blind delivery in the batch's own
  lane, so subscribed components re-render and commit with the batch;
- the slot lifecycle composes cleanly: per-root membership rows clear at
  retirement, strictly before the slot is released (invariant-checked on
  every step), so a recycled slot can never impersonate a member.

No discrepancy here on its own — **but** this surface composes with
*flag 5* into finding 5.3 below: such a late write is invisible to every
condition the mount fast path checks.

## flag 4 — the pin cap on included-batch visibility

A pass world admits an included batch's receipt only up to the pass's
pin (`slot included ∧ seq ≤ pin`). The cap is what keeps a paused
render's world from drifting: a *committed-member* batch that is still
live (the parked-action shape above) can write after the pass pinned,
and without the cap the pass would fold that write mid-render — the same
render would answer differently before and after the pause, which is
tearing within one render. The cap loses nothing: the write is
committed-visible at now and at every later pin. Removing the cap in the
model makes a yielded pass's value change across a yield — exactly the
drift the contract forbids ("a pass observes included-batch writes only
up to its pin, forever, across pauses").

## flag 5 — the mount fast path is not standalone

At a mount's commit, reconciliation normally (a) schedules a corrective
re-render into the lane of every live non-included batch that touched
the mounted node, then (b) compares the mount's rendered value against
its view fast-forwarded to committed-truth-now, correcting urgently
before paint. A **fast path** may skip the comparison when four
conditions suggest the mount window was quiet:

1. the pass that mounted the component is the pass now committing;
2. no committed-side advance happened since the pass's pin;
3. the root's commit generation is unchanged;
4. no batch included in the render wrote after the pin.

Three findings sharpen this rule:

1. **When the written batch stays live, an urgent correction still
   fires — correctly.** An earlier design walk claimed that if the
   included batch that wrote after the pin stays live (instead of
   retiring at this commit), the corrective loop alone covers it and the
   final comparison comes out equal — no urgent correction. That claim
   is wrong: the commit's own lock-in precedes layout, so
   committed-for-root already includes the batch's post-pin write via
   membership, and the fast-forwarded view folds it — the comparison
   fires. The fired correction is genuinely true (committed truth really
   moved before paint), so behavior is sound; only the "no correction"
   expectation was wrong. Pinned in `battery.spec.ts` case 9 (d′).

2. **Check the committing batches' write clocks at commit time, not a
   slot set captured earlier** (found by fuzz seed 29, shrunk to 5 ops).
   Condition 4 as first written quantified over the *slots captured in
   the mask at pass start*. A rendered batch whose **first** write lands
   mid-pass interned its slot only after that capture, so "every
   captured mask slot's write clock ≤ pin" is vacuously true for it. If
   that batch then also retires at this very commit, the fast-forwarded
   value moves while all four conditions hold — and no live batch
   remains for the corrective loop to cover. The sound form, which the
   model implements: at commit time, check the committing pass's
   rendered **batches** themselves (latest write seq ≤ pin), so a
   member whose first write landed mid-pass is seen.

3. **The fast path is only sound together with the per-batch corrective
   loop** (found by fuzz seed 173, shrunk to 9 ops). A live batch
   already committed into the root (the *flag 3* surface) takes a write
   after an unrelated same-root pass pinned. Every condition is silent:
   no committed-side advance (a live write is not a retirement), the
   root's commit generation is unchanged, and the mask clocks say
   nothing (the batch is in the committed set, not the mask). The
   fast-forwarded value diverges while the fast path holds. It is not a
   tear only because step (a) already scheduled that batch's corrective
   re-render. The corrective loop is therefore a *premise* of the fast
   path, and the sound invariant — asserted by the model on every
   mount — is: **any divergence the fast path hides must be exactly
   covered by scheduled correctives.**

Related legality rule the fast path depends on (found by fuzz seed 97):
**a retirement folded inside a commit must belong to a batch that commit
rendered.** A foreign batch retiring inside another pass's commit would
land after that commit captured its baseline and silently break the
fast path's accounting forever. In a real React host the schedule is
unreachable — a foreign batch retires at its own closure, which is the
mid-pause shape tested in `battery.spec.ts` case 9 (c) — and the model
enforces it as a schedule-legality rule in `passEnd`.

## flag 7 — forced slot release is safe

A retired batch's slot normally stays held while any open pass's mask
names it. If every slot is held and a new batch needs one, the model
releases the oldest retired-but-retained slot anyway, loudly. This is
safe with no extra bookkeeping because receipts record their slot
permanently at mint: the retained pass's world replays byte-identically
before and after the forced release, and the new tenant's world folds
both tenants' history in global timeline order with nothing
double-applied (every claim is sequenced after the previous tenant's
retirement). The model recomputes notification routing from scratch, so
it has no cached dirty state to preserve across the release; an engine
that caches such state must keep it intact — the observable half, which
is all the model can see, holds under fuzzing and the targeted corner
tests (`flags.spec.ts` flag 7, `scars.spec.ts` S29b).
