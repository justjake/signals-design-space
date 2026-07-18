# Review: design-fork-native.md — Claude reviewer, round 1

Design reviewed: `design-loop/rounds/round-01/design-fork-native.md`
Method: re-walked C1–C17 against the design's own mechanisms; attacked
Constructions A and B and QUEUE-STABLE with counter-schedules; enumerated
mechanism pairs sharing state (edges×walk×gate, fold×retirement×memo,
tags×per-root commits, dedup×partial commits, comparator×discarded passes);
ran the lifecycle and fork-honesty audits.

Summary of the defect family behind the blockers: worlds in this design
legitimately diverge along **three** dimensions — lane exclusion (a live
default/sync batch excluded from another batch's render, C2), retirement
time (a token flipping to fully-retired mid-pass), and per-root commit skew
(C11). The safety net (gateSet tags, fast-out, skew windows, tag clearing)
is keyed almost exclusively to **deferred-token liveness** and **one root's
commit edges**, so divergence arriving via the other dimensions never opens
a window. Each blocker below is one dimension getting through.

---

## F1 — BLOCKER. Edge re-tracking from a live default/urgent pass world poisons the walk for excluded-world commits; every gate window stays shut

**Mechanisms defeated:** M7 (committed-class re-tracking, §6.2), M8 (walk),
M5 (gate fast-out §7.1 + all tag sources §7.2), Construction B case (ii)
premise P-fresh.

The design defines committed-class as "no live **deferred** token" (§1) and
re-tracks canonical edges during such evaluations — including render passes
for live, *uncommitted* urgent/default tokens (C1-T4 step 3 does exactly
this under mask {U}). But C2 proves a live default batch can be **excluded**
from a later sync render+commit. Re-tracking from the {D}-world therefore
installs edges that are wrong for the sync-lane committed world — the §6.2
T4 poison reproduced with `D` in place of `k` — and no gate window opens
because every trigger requires live *deferred* tokens.

**Schedule:**
```
setup | committed flag=false, a=0, b=0; c = flag ? a : b; W watches c,
      | W_b watches b; edges(c)={flag,b}
1 | timer: flag.set(true) → default token D (deferred=0) | walk: flag→c→W:
  | setState(W)@D; stale-marks c; NO gateSet tag (§7.2 stale-window requires
  | live deferred tokens — none)
2 | D-pass P1 (concurrent, mask cm∪{D}) renders W | c evaluates: flag=true
  | → a=0 → c=0; mask has no live deferred token → committed-class per §1
  | → RE-TRACK edges(c)={flag,a}  (same rule C1-T4 step 3 applies)
3 | P1 yields (time slice; default renders are time-sliced)
4 | click handler in the gap: b.set(9) → sync token U | walk from b:
  | edges(c)={flag,a} — no b→c edge → W NOT notified; W_b⟵setState@U
5 | sync flush: mask cm∪{U}, D excluded (C2, native lane filtering) |
  | W_b renders b=9; W has only a D-lane update → skipped, shows c=0
6 | onBeforeCommit(root,{U}) | gateSet EMPTY (step 1 and step 4 tagged
  | nothing); fast-out: gateSet empty ✓, "no live deferred token wrote
  | anything" ✓ (D and U are both urgent-classified), no skew ✓ → return
7 | COMMIT | screen: W_b=9 next to W=c=0; the U-committed world is
  | flag=false, b=9 ⇒ c=9. TORN FRAME. If D then suspends, the tear
  | persists indefinitely; otherwise it lasts until D's own commit.
```

**Why the design's own defenses miss:** the walk misses (edge dropped in
step 2); PF-2/PF-3 don't apply (U ∉ D's mask, W has no U update); the gate
never sweeps (every §7.2 source and the fast-out clause are
deferred-keyed); and even a generous stale-window tag of `{D}` at step 1
would be skipped by the sweep filter at step 6 (`{D} ∩ {U} = ∅`).

**Internal inconsistency making this worse:** §1's parenthetical defines
committed-class as "fully-retired ∪ urgent-**committed**", but C1-T4 step 3
re-tracks under a live urgent mask. Under the strict (parenthetical)
reading F1 disappears — and F2's rescue path disappears with it (see F2):
at least one of F1/F2 fires under every consistent reading.

**Judgment: local fix, load-bearing.** Rule change inside the architecture:
never re-track canonical edges from any evaluation whose mask contains ANY
live token; make §7.3 commit-time adoption the sole render-path edge
refresh (the mechanism already exists), and key gate windows/fast-out to
any-live-token divergence rather than deferredness. Construction B's P-fresh
must then be restated and re-proven, and the gate's "two null checks while
typing" pricing re-derived (fast-out now dies whenever any batch is live).

---

## F2 — BLOCKER. `fold` dropped the retirement watermark: a token retiring mid-pass drifts the pinned pass world; torn render commits with the gate blind

**Mechanisms defeated:** M1 (visibility rule §4.1), M9 (per-pass memo as
world pin), M3/C7 walk ("values identical to pre-yield" — false),
QUEUE-STABLE (proven for base advance; the killing event is the
retirement *flip*, one level up), Construction B base/step ("rendered ones
are correct by M9").

§4.1 claims its visibility rule is "verbatim from the mechanism library,"
but the library's rule is `visible iff (retired ≤ pin) ∨ (batch ∈ mask ∧
seq ≤ pin)` — the design dropped **both pins**. The `seq ≤ pin` drop is
compensated by PF-3 restarts (in-mask writes force a re-pass). The
`retired ≤ pin` drop is compensated by nothing: `fullyRetired(op.token)` is
evaluated at read time, and tokens retire mid-pass — a batch closing with
no React work (C12's own mechanism) or committing on *other* roots, both of
which happen inside another root's yield gap. React never needs this pin
because hook queues are per-fiber/per-root; SharedQueues are global and
many-consumer — exactly the disanalogy the fork charter demanded be
confronted. The per-pass memo pins only *already-read* nodes; anything
first read after the mid-pass retirement folds the newer world.

**Schedule** (stated under the strict committed-class reading; see the
pincer note below):
```
setup | committed f1=f2=false, x=0, b1=b2=0; c1 = f1 ? x+100 : b1,
      | c2 = f2 ? x+100 : b2; W1 on c1, W2 on c2 (root A); W_x on x
      | (root B). edges: c1={f1,b1}, c2={f2,b2} — x has no edge to c1/c2.
1 | timer: f1.set(true); f2.set(true) → one default token D | walk:
  | setState(W1)@D, setState(W2)@D; no tags (no live deferred tokens)
2 | D-pass P on A (mask cm∪{D}) renders W1 | c1: f1=true → x:
  | fold(x, mask)=0 → c1=100; memo(P)[c1]=100
3 | P yields. Click: x.set(1) → sync token U | walk from x: no edge to
  | c1/c2; W_x⟵setState@U; sync render+commit on B; U's only observing
  | root committed → onRetire(U) fires IN THE GAP; fullyRetired(U)=true
4 | P resumes; renders W2 | c2: f2=true → x: fold(x, cm∪{D}) — U now
  | satisfies the fullyRetired clause → x=1 → c2=101
5 | P completes: W1 rendered 100 (x=0), W2 rendered 101 (x=1) — torn
  | within one pass
6 | gate at A's D-commit | gateSet EMPTY (no deferred token was ever
  | live → no stale-window/adoption/mount tags; skew condition not met);
  | fast-out: no live deferred wrote ✓ → COMMIT. TORN FRAME published:
  | sibling components disagree about x in one committed tree.
```

**The F1/F2 pincer:** under the loose reading (C1-T4's), step 2's
evaluation re-tracks c1 to {f1,x}, so step 3's write delivers and React
restarts A — F2's schedule is rescued, but that same re-track is precisely
F1's poison (write b1 instead of x and F1 fires). Under the strict reading
F1 is closed and F2 fires as walked. No reading closes both.

**Judgment: local fix, load-bearing.** Restore the retirement watermark:
fold against `retiredSeq ≤ pass.pin` captured at onPassStart (S9 already
carries pass identity), plus a fork edge "token retired while passes are
in flight" that forces re-pass or gate validation of affected roots. This
is a rule change inside M1/M3 plus one PF invariant — but it breaks the
"clause-for-clause React's filter" isomorphism claim (React needs no
watermark; a per-root/global disanalogy the spec must own), T-SQ1/T-SQ2 as
specified cannot catch it (single-queue, single-root differentials), and
C7's walk and Construction B must be redone.

---

## F3 — BLOCKER (within the declared full-spanning scope). Spanning skew: gate tags are cleared at one root's commit while the hazard lives until global retire; the skew condition tests the wrong root's mask

**Mechanisms defeated:** M5 §7.2 skew-window + "clear validated token bits"
lifecycle, §7.3/§7.2 adoption self-healing, C11 walk step 6.

Two independent letter-level defects compound: (a) the skew-window
condition fires when "another root r′ has a committed-mask differing from
fully-retired" — but in the canonical hazard it is the *re-tracking* root
whose mask differs (cm(A) ∋ live k) while the lagging root's committed
mask equals fully-retired exactly, so no tag is created; (b) tags that do
exist are cleared when *one* root's commit validates them ("entries die at
mask 0"), while the edge/world divergence persists until the token fully
retires on all roots.

**Schedule:**
```
setup | c = flag ? a : b; W_A (root A), W_B (root B) both watch c;
      | committed flag=false; edges(c)={flag,b}
1 | transition k (spanning): flag.set(true) | walk: setState(W_A)@k,
  | setState(W_B)@k; stale-window tag (c, {k}) — k is live+deferred ✓
2 | A renders k; gate at A's k-commit sweeps c (tag∩{k}≠∅): W_A rendered
  | in the pass → validates → "clear the validated token bits" → entry
  | dies at mask 0. cm(A)+={k}. Per §7.2's self-healing clause the gate
  | evaluation's world equals A's new committed class → edges(c) adopt
  | {flag,a}.   (If adoption is read narrowly and edges stay {flag,b},
  | run the mirror schedule on root A with a.set — same outcome.)
3 | B has not rendered k yet (pending/suspended). Urgent U: b.set(9) |
  | walk from b: edges(c)={flag,a} → W_B NOT notified; W_b′ (direct b
  | watcher on B) notified@U
4 | B's U-render: W_B skipped (no U update), shows c=0 | gate at B's
  | U-commit: fast-out fails (slotClock[k] changed since B's last commit)
  | → sweep runs — but gateSet has NO c entry (cleared in step 2, and
  | the skew condition (a) never re-tagged: cm(B)=fully-retired) → commit
5 | TORN on B: W_b′ shows b=9; W_B shows c=0; B's committed world says
  | c = (flag=false → b) = 9.
```

Note the sweep filter compounds it: even a surviving `{k}` tag intersected
against `M={U} ∪ cm(B)-deltas` is skipped — skew-class entries need
validation at **every** commit of any root whose committed class lags the
edge world, regardless of M.

**Judgment: local fix inside M5/M7 lifecycles, shared with F1's repair**
(edge refresh per-root at commit; skew entries keyed to "∃ root whose
committed class differs from the edge world", lifetime = until global
retire, sweep filter ignoring M for that class). Priced as transient
(spanning windows are rare) but must be re-priced. If the repair is judged
too heavy, the design's honest retreat is degrading the C11 scope
declaration — the case explicitly permits that, but the spec as written
declares full spanning and its walk step 6 claims coverage this schedule
disproves.

---

## F4 — HIGH. Retirement edges deliver no notifications: `useSignalEffect` (and, post-F2-repair, watchers) never observe retire-time committed-world deltas

**Mechanisms defeated:** M6 committed views ("advanced at retirement/commit
callbacks", §1 — no notification mechanism exists at the retirement half),
C16 walk step 3 (its only re-run trigger is onCommit on that root),
C12×C16 seam.

**Schedule:**
```
setup | root r: component with useSignalEffect(() => sync(a.state));
      | no rendering watcher of a anywhere
1 | startTransition(() => a.set(5)) | walk: no watchers → no React work
  | on any root
2 | k closes with no work → onRetire(k) → base(a)=5 (D2) | r's committed
  | world (fully-retired) now says a=5
3 | nothing schedules r: no onCommit(r) ever fires; React never flushes
  | passive effects on r | the effect never re-runs — sync() holds a=0
  | indefinitely (until some unrelated commit happens to land on r, and
  | even then only if the flush machinery marks this effect)
outcome | lost observation: committed state changed (C12 guarantees the
  | write persists) but the committed-state subscriber (R4's contract)
  | never hears about it
```

The design says core `effect()` re-runs "on retirement edges" (§4.3), so an
onRetire-driven committed-topology walk half-exists — but `useSignalEffect`
flushes ride React's passive-effect machinery, which needs a commit. After
F2's watermark repair, the same blind spot extends to watchers: a pass
pinned before a retirement renders one world behind the new committed
world, and nothing walks at retire to correct them (the mechanism library's
"reconcile check at fold" was not adopted).

**Judgment: local fix** — an onRetire handler that walks committed topology
for the retired token's written atoms and (a) schedules signal-effect
flushes (microtask or an urgent no-op update on affected roots), (b)
compares watcher lastRendered values (reconcile-at-fold). Costs a
retire-edge walk; retire frequency is per-batch, not per-write.

---

## F5 — MEDIUM. Dedup bits pruned at global retire, not per-root commit: a same-token write landing after a partial commit delivers no setState

**Mechanisms:** M8 dedup ("dedup maps (pruned at onRetire)", C13 table) vs
PF-2's per-root scope ("until t commits" — commits are per-root).

**Schedule (reachability conditional):** k spans roots A and B; k writes
`a` → setState(W_A)@k, dedup[W_A][k] set; A renders and commits k (B still
pending, k live). If any k-tagged write to `a` can land now — multi-segment
async action semantics permitting a commit of segment 1 before settle, or
any future runInBatch use that dispatches atom writes — the walk finds
dedup[W_A][k] set → no setState; W_A has no pending update (consumed at
A's commit) → no render is scheduled on A at all; committedView(a,A) folds
cm(A) ∋ k so effects see the new value while W_A's frame holds the old one;
the gate never runs (no commit scheduled on A) and its sweep filter skips a
`{k}` tag at non-k commits anyway. Stale frame until something unrelated
re-renders W_A.

Whether React's async actions ever commit pre-settle work is exactly the
kind of fact this design must pin with a fork test (the spec's own C12 walk
parks retirement but is silent on per-segment commits). **Judgment: local
fix, cheap hardening either way** — clear dedup[W][t] for W's root at
onCommit(root, {t}) instead of onRetire; one lifecycle line. State the
async-action commit fact explicitly in §9.3 with a test.

---

## F6 — MEDIUM. Gate comparator uses `lastRenderedValue` recorded on *completed* (including discarded) renders; the no-torn-commit proof implicitly requires a commit-grade record

§5.3: watcher records update "at every completed render of the component"
— render-function completion includes passes that are later discarded.
The gate (§7.1 step 2) compares world values against this record; a value
from a discarded pass was never on screen. I attempted a standalone torn
commit from this and **failed** — I4 (first-divergence) plus delivery
closes every schedule I constructed (the poisoned comparison only becomes
load-bearing on paths that already require F1/F2/F3). It remains a
soundness hole in the stated proof and a compound-failure amplifier.
**Judgment: local fix** — snapshot lastRenderedValue/lastRenderMask/clock
records at the commit edge (C-5 exists) rather than during render.

---

## F7 — MEDIUM. Gate sweeps and mount fixups evaluate computeds with writes enabled

R8 tolerates acyclic writes-inside-computeds (configurable), and the
design's write rejection uses *render-callstack* truth only (C14 walk:
throw iff getRenderContext() ≠ undefined). onBeforeCommit/layout fixups are
not render callstacks, so a computed that writes (legal under the config)
dispatches mid-sweep: queue/hot/slotClock mutate between two swept nodes'
evaluations, the sweep's "fold-world (committed[root] ∪ M)" is no longer
one world, and corrections can validate against a moving target (outcome:
false-validate → stale frame, or an unbounded correction loop surfacing as
React's update-depth crash). **Judgment: local fix** — evaluate sweeps and
fixups under an explicit writes-forbidden scope flag (same throw R8 already
specifies for render-world evaluation).

---

## F8 — MEDIUM. Suspense worldId churns when a suspended pass's mask gains live urgent tokens (spanning window): thenable identity lost, refetch loop possible

C15 walk step 3 asserts "same token set ⇒ same w_k" across retries. If
"included-token-set" means live tokens in the mask, a spanning urgent U
(committed on this root, live because another root lags) enters the retry
mask: {k} → {k,U} ⇒ new worldId ⇒ thenable cache miss ⇒ re-mint ⇒ re-suspend
(PF-6: "fresh set ⇒ fresh id"). Repeated urgent spanning traffic during a
suspension refetches each time. The rescue the design itself mentions —
"settled promise reused if args-equal via library-level request dedup" —
appears only as a parenthetical policy aside in C1-T7. **Judgment: local
fix** — either define worldId's token-set over live *deferred* tokens only
(urgent deltas change values, and args-mismatch already re-fetches
correctly), or promote request-level dedup from aside to normative
mechanism with its own lifetime rules. Single-root flows are unaffected
(urgent tokens retire at their commit and leave the set).

---

## F9 — MEDIUM (cost honesty). React-mode watcher delivery has no cutoff at all; this is the same 10k-no-op-render shape §12 uses to kill the maximal variant

§5.2 delivers setState to every watched node reached by the walk with no
value evaluation ("no eager per-world evaluation on the write path"), and
§11 prices the result as "one no-op component render per (watcher, token)"
— per suppressed write, per watcher. With `c = a*0 + b` and 10k watchers on
c, every `a.set` in React mode schedules 10k renders that cannot change
output — §12 kill-schedule #1's regression shape, accepted in the viable
design with only a "v2 selector-grain isEqual knob" sketch. alien-class
effect suppression (schedule → pull-verify → cancel) is absent for
watchers. P1's useState-parity gate genuinely doesn't cover it (equivalent
useState re-renders too), so this is a documented divergence rather than a
gate breach — but research-facts G-7 demands the chosen mitigation be
priced, and no spike row covers suppressed-write fan-out. **Judgment:
local** — add a numeric gate/spike (suppressed-write × watcher-count grid)
and either accept with numbers or specify the watcher-grain cutoff
(one committed-world evaluation of the watched node per write is the
priced-expensive shape; a staleness+lazy-verify delivery is the known
alternative). As written this is the design's largest unpriced hot-path
divergence from the donor semantics its P2 story leans on.

---

## F10 — MEDIUM. Render-phase writes mutate state before they throw

§5.2 order: dispatch appends the op (fork), then onWrite updates the hot
slot and bumps slotClock, **then** checks getRenderContext() and throws.
The rejected write persists: queue holds an op minted under a render-lane
classification, hot shows the new value to any untracked read, slotClock
advanced. C14 requires render purity — a StrictMode replay or discarded
pass leaves observable world mutation behind (and the orphan op folds at
that token's retire, silently committing a "rejected" write).
**Judgment: local fix** — reject before append: dispatch consults the
render-context getter first (it is fork-side and already exported via S9),
or C-1 fires pre-append with a veto. One ordering change; add a StrictMode
render-write test asserting the queue is untouched after the throw.

---

## F11 — NOTE. Misquote of a frozen seed, and the definition fork feeding F1/F2

§4.1 claims the visibility rule is "verbatim from the mechanism library";
the library's rule carries `retired ≤ pin` and `seq ≤ pin`, both dropped
(the former is F2's root). §1's committed-class parenthetical
("urgent-committed") contradicts C1-T4's re-track-under-live-urgent (F1's
root). Fix the text whichever way the repairs land — as written, two
load-bearing definitions each have two readings.

## F12 — NOTE. Global `seq` wrap has an acknowledged test but no named guard

C13's table scopes seq comparison to "live ops of one queue" and promises a
"wrap horizon test," but names no mechanism making cross-wrap comparison
safe for a queue held open across ~2³² writes (held-open transition during
heavy traffic). Every other counter row names its guard (gen, prune,
retire-edge). Name one: float/53-bit seq, or per-queue epochs. Cheap.

---

## Verified held (attacked and survived)

- **C2 (flushSync excludes default):** attacked via every canonical-cache
  leak path I could construct — render reads structurally never consult
  hot/committed caches; always-log + per-mask fold serves both `a=0` and
  `c=10`. Held.
- **C3 (rebase parity):** fold replay-in-write-order over pre-batch base
  with the first-unretired-op base freeze reproduces 2 → 4 → commit 4 and
  the set-5 variant; I2 honored; differential tests pin drift. Held.
- **C4 (per-token re-notify):** per-(watcher, token) dedup is I5-compliant;
  two tokens ⇒ two setStates. Held (lifecycle nit F5 aside).
- **C5 (second write reaches watcher):** PF-3 restart + PF-2 fresh render +
  per-pass memo death make evaluation #1 unservable. Held (cost flagged
  F9).
- **C6:** per-write synchronous delivery inside fork dispatch preserves
  writer context by definition; no implicit grouping exists. Held.
- **C7 (routing half):** per-callstack getRenderContext avoids S7
  structurally; yield-gap reads hit hot, writes classify natively. Held —
  the *determinism* half of the walk fails (F2).
- **C12:** fold-at-retire unconditional (D2); persistence never consults
  subscription; async parking stated with tests. S4 avoided. Held.
- **C13:** token/slot/slotGen/passSerial/worldId lifecycles each carry a
  named guard + forced-wrap test. Held except F12 (seq guard unnamed).
- **C14:** memo-keyed idempotent replays; deferred worlds never write
  edges; native render-write detection. Held (ordering leak F10 aside).
- **C9(b) fresh nodes:** mask-at-read-time routing means a node with no
  edges/marks reads the pass world correctly on first render; verified no
  double render needed. Held.
- **C10:** runInBatch entanglement vs fresh-transition alternative argued
  correctly; retired-race urgent pre-paint fallback present. Held.
- **C17:** surface deleted; legitimate per the case's own escape clause.
- **Construction A:** holds as intended — the three durable caches cannot
  hold live-deferred-world values; the hot slot's "mask=ALL" exemption is
  the documented newest-world contract (C7 requires it), and the thenable
  carve-out stores identities, not folds, with fork-managed lifetime.
- **§12 maximalist kill:** all three killing schedules verified sound
  (cutoff loss at fiber grain, R13's no-fiber consumers, creation cost).
  The irony that kill #1's shape survives into React-mode delivery is F9.
- **Gate comparator standalone attack failed** (see F6): I4 + delivery
  close pure comparator-poisoning schedules — recorded as verified-held
  for the non-compound case.
- **Scars:** S1 (always-log ✓), S2/S3 (walk demoted to optimization with a
  gate — the *stance* avoids the scar; F1/F3 are gate-scope bugs, not a
  repeat of "the walk never misses"), S4 (✓), S5 (no certificates exist),
  S6 (monotonic latch ✓), S7 (per-callstack ✓), S8 (I7 empty-history rule
  ✓). No scar repeated as designed.

---

## Verdict

The central inversion — walk as optimization, fork-owned pre-commit gate
as the correctness guarantee — is the right shape, but the gate's trigger
taxonomy is keyed to deferred-token liveness and single-root commit edges
while worlds also diverge via default/sync lane exclusion (F1), mid-pass
retirement (F2), and cross-root skew (F3), so three torn-commit schedules
walk through the net, and Construction B's premises (P-fresh, M9-pins-the-
world) are false as stated. All three repairs are rule changes inside
existing mechanisms (retirement watermark pin in fold; edge refresh only
at per-root commit adoption; any-live-token gate windows with
lag-root-scoped tag lifetimes) plus a retire-edge notification walk (F4) —
no new load-bearing mechanism class, but Construction B, the C7/C11 walks,
and the gate's fast-out cost story must be re-proven and re-priced after
repair. **Verdict: repairable** — not implementation-ready (three
blocker-severity torn-commit schedules stand), and not architecturally
unsound (the SharedQueue/fold/memo/gate skeleton survives every schedule
found with its semantics intact).
