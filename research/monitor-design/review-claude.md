# Adversarial review — research/monitor-design/DESIGN.md ("cosignal, the monitor's cut")

Reviewer: claude (independent; did not read rounds/ or other designs).
Method: battery re-walk, counter-schedules against every dissolution claim,
seam enumeration between the two kernels / tape / delivery / lock-in,
lifecycle audits, fork-honesty and cost-honesty checks.

Summary: 4 BLOCKER, 4 HIGH, 4 MEDIUM, 2 NOTE. The K0/tape/visibility core
and the new re-arm rule survive attack; the failures cluster in (a) the
pinless HEAD-serving pass path, (b) two drain paths the dissolution ledger
silently omits rather than dissolves, and (c) two scar repetitions defended
as scope. Verdict at the end: **repairable**.

---

## Findings (most severe first)

### F1 — BLOCKER. Pinless HEAD-path pass serving + writing-kernel-only delivery ⇒ torn commit (S18 class)

Two design statements combine fatally:

- §10: "held-open transition reads | K1 kernel caches (**no memo machinery
  on the HEAD path at all**); pass worlds pay replay+memo only when masks
  differ from HEAD/BASE" — i.e. a pass whose mask equals the live batch set
  serves **live K1 caches with no pin protection**.
- §5 step 4: delivery "walk[s] **the writing kernel's** edges" — for an
  urgent write, K0 only. (The C1 walk says urgent writes "propagat[e] in
  both", but propagation ≠ delivery, and the normative write-path text says
  writing-kernel.)

**Schedule.** Atoms `flag=false, a=0`; computed `c = flag ? a : 99`;
canonical deps of `c` = {flag}. Transition T writes `flag=true` (K1
propagate via canonical edge reaches c; watcher W1 delivered in T's lane).
T's pass P starts, mask {T} = HEAD, so P serves K1 caches directly (no
memos, no pin use). W1 renders, head-evaluates `c`: reads flag=true, reads
`a=0` → c=0; K1 records edge `a→c`. P **yields**. A timer handler runs an
urgent `a.set(5)`: receipt appended; applied to K0 (K0 walk from `a`: **no
K0 out-edges** — `a→c` exists only in K1 → no delivery, no setState, no
React work in the urgent batch); mirrored into K1 head values, K1
propagation invalidates c's K1 cache. The urgent batch closes with no React
work and retires (fold: K0 propagation from `a` reaches nothing). P
**resumes** — nothing forced a restart, because no delivery ever produced an
interleaved update. A component W2 mounts in the resumed pass and reads `c`:
K1 pull recomputes against the **drifted head** → flag=true, a=5 → c=5. One
commit: **W1 shows 0, W2 shows 5** — torn frame matching no world.

Mechanisms defeated: HEAD fast path (no pin), delivery walk (kernel-scoped),
the restart guarantee the design implicitly leans on (restarts only happen
when delivery schedules React work). This is exactly the scar-S18 shape:
pinless shared world serving; scar repetition is an automatic blocker.

**Judgment: local fix, with a cost confession.** Repairs: (1) every delivery
walk traverses the K0∪K1 union (this also matters for F2); (2) the HEAD
fast path must either take pin protection (per-pass memos over K1 — i.e.
the deleted memo machinery returns for yielded passes) or carry a proven
invariant "any K1 mutation while a HEAD-serving pass is pinned forces that
pass's restart," which requires delivery to be union-walked *and* a fork
guarantee that an interleaved update in any lane discards the WIP pass
(currently an unstated assumption about `prepareFreshStack` — see F11).
Either way the §10 cost row "no memo machinery on the HEAD path at all"
dies as written.

### F2 — BLOCKER. Edge-add retroactive delivery (I23) and lock-in watcher reconcile (I47) are absent, not dissolved ⇒ io-gated committed tear (S35 rebuilt)

The dissolution ledger (§7) claims six dissolutions and lists the surviving
conjuncts. **I23 (a K1 edge recorded after a write must replay still-live
receipts' deliveries through the new edge) and I47 (every committed-
visibility flip — retirement AND per-root lock-in — must reconcile
watchers, not only effects) appear in neither list.** They are simply gone.
No construction dissolves them, and the S35 schedule runs verbatim against
this design:

**Schedule.** `c = flag ? a : b`, canonical flag=false, K0 deps of c =
{flag, b}; W mounted on c. Parked async action K (store-only pre-await
write) writes `flag=true` → delivered to W in K's lane (canonical edge). K's
pass starts (pin p), **yields before evaluating c**. Store-only default
batch D writes `a` (seq > p): delivery walk from `a` — no K0 edge, no K1
edge (c not yet head-evaluated, `a` never shadowed) → nobody delivered. D
retires: fold writes `a` through K0; K0 propagation from `a` reaches
nothing; touched-list flush over {a} reaches no observer of c (the a→c edge
does not exist yet). K's pass resumes, head-evaluates c: pass world
correctly excludes D (seq > pin) → c = a_old; **K1 edge a→c recorded now,
after D's receipts retired**. Pass commits; K locked into root R.
committed-for-root(R) = retired{D} ∪ locked{K} ⇒ c = a_new. Committed DOM
shows c = a_old. No mechanism fires: `runInBatch(D)` was never attempted
(no fixup runs at edge-add), lock-in mints a visStamp but **notifies
nobody** (§5 lock-in has no flush step; §5 step 4's flush is
retirement-only), and K's retirement — the eventual corrector via the
flag→c K0 fold — is **parked on io**. Torn committed frame for an unbounded
duration. `useSignalEffect(c)` is equally stale (D's flush ran before the
edge existed), so even the effects clause fails here.

Mechanisms defeated: per-write delivery (edge didn't exist), retirement
flush (ran too early), lock-in (no drain), first-divergence induction (the
first divergence *flag* was caught — the *subsequent* divergent dep `a` is
exactly the case K1 edges exist to cover, but the edge was born after the
writer died). Note this is not the F1 union-walk gap: even a union walk
finds no edge at write time.

**Judgment: local fix** (reinstate I23 edge-add retroactive delivery with
the I18 retired-token fallback, and an I47 watcher-reconcile drain at
lock-in/advance) — but each is a real mechanism with real hot-path cost,
and the "residual weight" list in §7 grows by two of the heavier items the
champion carried. The dissolution ledger over-claims by omission.

### F3 — BLOCKER (scar repetition). "Equal-value refetch on relevant-atom churn is accepted in v1" is S31 verbatim

§9/C15: "Equal-value refetch on relevant-atom churn is accepted in v1
(noted optimization: stepwise value revalidation)." S31's rule (I35) is not
an optimization; it is the recorded repair for a kill-class schedule:
stamp-move ⇒ refetch on side-effect-bearing caches produces duplicate
side-effectful fetches and transition starvation.

**Schedule (S31 instantiated here).** Transition T suspends on capsule Q
whose evaluation touched atom `a` (fingerprints: slotClock[T], later
visStamp[a]). User types; each keystroke urgent-writes `a` with an equal
value — tape is non-empty (T live, `a` touched), so every write appends
(correct per S8). Each urgent batch retires within a frame; each retirement
fold is a value-no-op but **mints visStamp[a]** (§5 step 3, required by
I21). Q's touched-atom fingerprint moves every keystroke → capsule content
invalid → settled thenable discarded → **refetch + re-suspend, once per
keystroke**: duplicate side-effectful fetches, and T cannot commit while
typing continues. Same shape fires content-neutrally on the lock→retired
visStamp handover for a spanning token (two stamps, one content).

Mechanisms defeated: capsule content validity (§6 table rows 2–3) composed
with I21's deliberate over-invalidation, minus the I35 value-revalidation
step that made over-invalidation safe for side-effecting caches.

**Judgment: local fix** — make I35 mandatory (fp mismatch → re-fold in this
world → equality-stable compare → re-stamp in place when equal → refetch
only on real change). The design already names the mechanism; "accepted in
v1" is the only thing wrong, and it is a scar repetition, hence blocker by
loop rule.

### F4 — BLOCKER (contract-level; judge decision). Post-await ambient attribution repeats S21 and reopens D15/D17 without new evidence; it is also undetectable

§1 row 1 + §5 parking: raw post-await writes land in their own ambient
batch; C12's async clause is re-declared to in-scope writes only.

**Schedule (S21 verbatim).** `startTransition(async () => { a.set(1); await
io(); a.set(2) })`, no subscriber. `a.set(2)` lands in its own default
batch and retires promptly **while the action is still parked** — committed
state moves before the action settles. C12-as-seeded is violated exactly as
recorded in S21.

The design's defense is real and should be weighed: React's own `setState`
after `await` behaves identically, React's docs prescribe the inner
re-wrap, I37 already records "ambient fallback is React parity," and the
payoff is the deletion of the entire carrier subsystem plus the
frozen-write-set lemma that dissolves watermarks (I25) and lock views. But
three problems stand:

1. **Reopening bar.** DECISIONS D15 ("Post-await signal writes belong to
   the action; C12 walks verbatim") and D17 (boundary = rung-2 transform +
   boot self-test) are settled; reopening "requires new evidence (a
   schedule or a measurement), not preference." The design brings an
   argument and a deleted prerequisite, not a new schedule or measurement.
2. **Detectability.** The battery preamble legitimizes restriction only
   with reliable detection at the point of rejection. S22/I30 *prove*
   userspace cannot detect post-await context without the transform — so
   the misattribution is **silent**: no throw, no dev warning is even
   possible. D17's boundary at least carried a loud boot self-test; this
   design carries nothing.
3. **Keystone coupling.** Dissolution 3 (no watermarks, no lock views,
   token-membership lock-in) is *derived* from this cut. If the loop
   declines the C12 re-scope, the frozen-write-set lemma collapses and I25
   watermarks + I34 lock views return — an architectural change, not a
   patch. (Given the cut, I attacked the lemma directly and it held: every
   receipt path — sync scope, ActionScope.run's fresh token, runInBatch
   correctives being React-updates-only, render-phase writes throwing,
   yield-gap writes classifying fresh — closes the set at the close edge.
   §11(5)'s audit obligation is correct and must be a CI check.)

**Judgment: architectural-decision-level.** Internally consistent given the
cut; blocker by the scar/decision rule until the judge amends C12 or the
design brings the required evidence class (e.g. a differential measurement
that React-parity ambient behavior is what `useReducer`-parity tests
actually pin).

### F5 — HIGH. Dissolution 2 hides the refresh cost as an unconditional post-commit double render — and any suppression of it reopens S30/S35

Dissolution 2 deletes quiescence refresh (I27) and full-cone exemption
carry (I42), arguing retirement folds propagate through K0 and rule 1
forbids stale serves. Re-walking it: the argument **only closes if the
retirement fold's K0 propagation delivers to every watcher in the changed
cone and that watcher actually re-renders** (the re-render's canonical pull
is what re-tracks K0 edges — e.g. records `a→c` in K0 — before the K1 reset
destroys the only copy of the edge). Checking the dedup rule at fold time:
lastDeliverySeq(=write-time d) ≤ lastStartedPassPin(=pass pin p > d) →
**deliver**. So the design, as written, re-renders **every watcher in a
deferred batch's cone a second time at commit**, immediately after the pass
that already rendered the same values (React bails at the diff, but the
render runs).

- **Cost horn:** this is an unpriced hot-path cost. §10's retirement row
  says "fold linear in touched atoms + one K0 propagation per changed
  atom" — no mention that the propagation carries a setState per watcher
  and a full second render per transition commit. P1 (re-render within 10%
  of useState) is directly threatened: useState transitions render once.
  The champion's refresh was an engine-internal K0 pull with **no React
  render**; this design replaced it with something strictly more expensive
  and didn't put it in the cost table.
- **Correctness horn:** the obvious "optimization" (skip fold delivery to
  watchers that rendered this world — inclusion+clock, like C9's mount
  skip) silently removes the re-track, and then: unfork resets K1, the
  next write to a K1-edge-only atom (`a` with K0 deps of c = {flag,b})
  reaches nobody, and the committed DOM goes stale until unrelated traffic
  — the S30 stranding schedule reborn. The design must state, as an
  invariant, that fold delivery to watchers is unconditional (or replace it
  with an engine-internal fold-time pull of stale watched nodes), and price
  whichever it picks.

**Judgment: local fix** (pick a horn, write the invariant, add the gate
row), but the "same correctness with less machine" claim is weakened: the
machine wasn't removed, it was moved into React renders.

### F6 — HIGH. The pre-batch base is load-bearing and has no written construction

Replay — pass reads (§3), retirement folds (§5 step 2), committed-for-root
(§3), C2's "replay from the pre-write base" — is everywhere defined "in seq
order over the pre-batch base." But urgent receipts are **eagerly applied
to K0** (§5 step 3), so K0's plane value is *not* the base the moment any
unretired urgent/default receipt exists (C2 is exactly this state). Nowhere
does the design say where the base value lives: capture-on-first-receipt
per atom? tape-carried prior value? How does the retention sweep (§5 step
5) advance the base when it frees the receipts that connected the stored
base to K0's current value? A wrong but natural choice (base := current K0)
fails C2 with `a=0, c=11` — the seed's canonical torn frame. By the loop
rule (a claim with no written construction), this is a finding, not a
quibble. **Judgment: local fix** (name the capture site, the sweep-time
base-advance, and the compaction interaction; add C13 forced tests for
base/epoch interplay).

### F7 — HIGH. Watcher-registration residency across kernels and across the K1 reset is unspecified

Head-world evaluations record dependencies in K1 (§4). A component mounting
during a transition subscribes during a head-world render. If its watcher
edge lives on K1's plane, the unfork bulk-reset destroys the subscription.
**Schedule:** transition T live; W2 mounts in T's pass, reads computed c
(K1 evaluation), subscription recorded K1-side; T commits and retires; K1
resets (no pinned pass); later urgent write to c's dep → K0 walk reaches
c → c's watcher list is… gone. W2 never re-renders again — permanently
stale committed DOM. The design needs one sentence it doesn't have: watcher
registrations live in a kernel-neutral (or K0-resident) registry keyed by
canonical node id, adopted at commit, visible to walks from both kernels
(the fold-time "reaches committed watchers via K0's own edges" already
assumes this without saying it). **Judgment: local fix**, but mandatory —
and the C9 adoption step ("K0 pull at NEWEST + K1 shadow if forked")
currently covers nodes, not subscriptions.

### F8 — HIGH. Replaced-committed-node lifecycle: the immutable-evaluator swap has no reclamation protocol (S15 class at the adoption edge)

§11(3) invited exactly this attack. Fresh nodes on the pass allocation list
are covered (free-on-discard; D19 shape). **Not covered: the OLD node at a
successful swap.** `useComputed(fn, deps)`: deps change → node n2 created,
adopted at hook commit; n1 — the previously committed node — is now
unreferenced by the hook but may still be referenced by anything the old
committed tree handed it to (a memo-bailed child subscribed to n1; a
`new Computed` closing over n1; a capsule fingerprint naming n1's atoms).
Two horns, both walked:

- **Free n1 at swap:** a bailed-out child still watching n1 reads a freed
  arena record next render → garbage value or crash; its subscription slot
  is recycled under it.
- **Never free n1:** every deps-changing render leaks one arena record
  forever. Schedule: a list component whose `useComputed` deps include a
  prop that changes per keystroke — K0 plane grows monotonically; K1 resets
  and lineage death reclaim nothing. This is scar S15's exact demand: "any
  'harmless discard' claim over arena state must name the reclamation or
  staging protocol."

**Judgment: local fix** (e.g. watcher-count + hook-release refcount with a
named sweep, or generation-tagged tombstones), but it must be written; the
dissolution of the evaluator swamp is otherwise genuinely sound (see
verified-held list).

### F9 — MEDIUM. Capsule settlement lacks the I50 exact-identity check

§6 row 4: "thenable settlement bumps its own capsule slot," and C15 keys
capsules by (lineageId, hook slot). Reusable slot + no stated validation of
*which* thenable settled = I50's schedule: refetches supersede the pending
thenable; the superseded one settles late, bumps the slot, capsule
unsuspends early / serves the wrong resource. Fix is one line (settlement
callback validates the exact thenable reference against the current
occupant), but it must be in the spec — generation counters are the
recorded dead end (S39). **Local fix.**

### F10 — MEDIUM. Requirement cuts contradict R2/D16 without the reopening evidence

`ctx.previous` is an R2 *requirement* ("`ctx.previous`" listed in the
frozen seed), and D16 settled its three-way world rule; the design cuts it
(§1) with "re-addable later." Same for `ctx.use` lazy-factory (D16-settled,
cut) and the reducer-identity semantics (D16-amended semantics replaced by
keep-original + dev-warn — which also silently diverges from `useReducer`'s
latest-reducer behavior, so R3's parity conformance needs an explicit
carve-out for reducer-swap rows or it fails). These are declared honestly,
but they are seed-requirement violations presented as scope, and the
reopening bar applies. **Judge decision; local either way.**

### F11 — MEDIUM. Fork honesty: two load-bearing reconciler behaviors are consumed but not protocol facts

(a) The saturation poke and every restart argument (including F1's repair
horn) assume "an interleaved update in a pass's included lanes causes React
to discard the WIP and restart" — a behavior of today's work loop, not one
of §8's six facts; the rebase drill fails for it (if React changed
resume-vs-restart policy, the library's consistency argument breaks and
nothing in the protocol notices). (b) The poke itself ("a corrective update
in that pass's own lanes") needs `runInBatch` against a possibly
multi-token mask — §11(4) concedes this is unverified. Both belong in the
protocol document with reconciler-level tests, per the fork charter's
edge-triggered rule. **Local fix.**

### F12 — NOTE. Seq-horizon story is thinner than C13 demands

"Renumber-and-hard-throw at the far seq horizon" — if renumbering is
quiescence-only, I49's never-quiescent horn applies; if the answer is
"float64 horizon is unreachable, hard-throw," say that and delete
"renumber." C13 still requires the forced-small-counter test for every
counter with a horizon (visStamps, slotClocks, K1 epoch are listed; seq's
own forced test and the pin-comparison behavior at the throw need a
sentence). **Local.**

### F13 — NOTE. Delivery-walk spec precision

"Walk the writing kernel's edges" (§5 step 4) contradicts the C1 walk's
"propagating in both" and under-specifies the watcher hop. After F1's
repair this becomes: *all* delivery walks traverse the K0∪K1 union with the
I32 generation stamp (the design already prices the stamp — good), watcher
hops resolved through the F7 registry. One paragraph fixes it; as written
an implementor can build the torn version in good faith.

---

## Verified held (attacked, did not break)

- **The delivery re-arm rule (§5 step 4)** — the design's newest math and
  §11's first worry. I attacked it with: the I44 schedule (same-slot
  post-pin write after a started/yielded pass → re-arms, delivers); C4
  (second batch = second slot key, independent dedup → delivered in its own
  lane); C5 (value-blind first delivery + suppression of the second write
  is covered by the pending unconsumed setState, and slotClock[k]
  invalidates the memo, so the eventual pass renders b=7); pass-started-
  but-discarded (re-arms — over-delivery, safe); an urgent pass on the same
  root re-arming a transition slot (over-delivery, safe); multi-root
  (per-root pins isolate correctly); pin==seq tie at the ≤ boundary
  (consistent with the visibility rule's own ≤). The suppression direction
  is sound because suppress ⇔ no pass started since the last delivery ⇔
  that delivery's setState is provably unconsumed and its eventual pass's
  pin exceeds the suppressed seq. Only demands: pin the init values
  (lastDeliverySeq init < first pin) and the tie cases in forced tests.
  **This rule is better than its author fears** — but note it is
  *deliberately* over-delivering (fold-time and cross-lane re-arms), which
  is load-bearing for F5's correctness horn.
- **Frozen-write-set lemma, given the F4 scope cut.** Attempted appends
  under a closed token: render-phase writes (throw, C14), yield-gap writes
  (fork-classified fresh), ActionScope.run (new token by definition),
  runInBatch correctives (React updates only — §11(5)'s audit stands as an
  obligation), entangled T2 (its own token, own close edge). Set closes.
- **Immutable evaluators as a dissolution of the S23/S28/S32/S34/I46
  swamp** (F8's lifecycle gap aside). The swamp came from *shared mutable*
  evaluator identity; per-hook node recreation routes evaluator identity
  through React's own committed data flow (useMemo semantics): a sibling
  can only see the new node via props/context that React itself versions;
  hidden-Offscreen "commit without effects" is moot because the swap is
  hook-state, not an effect (I41's edge is inherited from React for free);
  StrictMode double-creates die on the pass allocation list. I could not
  drag the publication machinery back in through the adoption edge — only
  the reclamation gap (F8).
- **Untracked-resolves-in-world (dissolution 4).** A canonical evaluation's
  untracked read hits the K0 plane value by construction — there is no path
  by which pending state enters a K0 cache, so the I33 taint set has
  nothing to mark. Temporal staleness remains licensed (standard untracked
  semantics). The design's own demand for a React-mode test family (§11(2))
  is right: donor `untracked()` semantics change observably in head
  evaluations.
- **C2/C3/C8 arithmetic** re-walked against the tape rules (given F6's base
  is built correctly): flushSync exclusion yields a=0/c=10 via replay +
  fresh pass evaluation; C3 folds 4-not-3 in both write orders and with
  urgent-first interleaving (K1 mirror application order matches seq-order
  replay); C8's empty-tape-only drop is sound for all op kinds *because*
  evaluators are immutable (I38a's staged-reducer hole is structurally
  closed), and non-empty-tape always-append is honored.
- **Saturation slot arithmetic:** a 32nd token can only be demanded while
  some slot is retired-but-unswept (React caps live batches at 31), so "the
  oldest fully-retired slot" always exists when the force-retire fires.
- **I52 dissolves with the frozen write set** (no post-lock-in writes can
  exist, so the single pin bound in C9's skip rule is sufficient) — a
  dissolution the design earns but doesn't even claim.
- **Visibility rule, retention sweep, one monotone seq line (I15/S12),
  epoch guards, K1 walk generation stamp (I32):** re-walked C7 (yield-gap
  urgent write invisible to the pinned pass; retention preserves its
  receipts) and the two-flag K1 cycle program (generation stamp
  terminates). Held.

---

## Verdict

**Repairable.** The core — two kernels, always-log tape with the frozen
visibility rule, per-write value-blind delivery with the new re-arm rule,
frozen-write-set lock-in — survived every counter-schedule I could build
*given its scope cuts*, and three of the six dissolution claims (evaluator
machinery, untracked taint, I52) are genuine structural deletions. But two
of the four blockers are torn-frame schedules an implementation would ship
(F1's pinless HEAD path, F2's missing edge-add/lock-in drains), one is a
recorded scar re-accepted as a v1 cost (F3), and one is the keystone scope
cut standing on an argument where the loop's own rules demand a schedule or
a measurement (F4); the repairs are all known machinery from the loop's
notes, which means the design's "less machine" margin shrinks materially
once it is made sound — the honest accounting is that dissolutions 2 and 6
partially *relocated* work (into post-commit double renders and back into
I23/I47 drains) rather than removing it.
