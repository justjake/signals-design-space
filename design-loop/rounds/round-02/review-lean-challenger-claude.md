# Review — design-lean-challenger.md (Claude reviewer, round 2)

Scope per reviewer prompt: adversarial correctness only. I re-walked C1–C17
(including the C1 T2–T7 family), attacked every §3 construction, probed
mechanism seams (M3↔M5 catch-up, M4↔M6 commit window, M6↔M2 lock-in order,
M7↔M2-clock, quiescence reset↔K0 edge truth), audited every counter in §6,
and ran the rebase drill against §5. Findings first, ranked; then verified
held; then verdict.

---

## Findings

### F1 — HIGH — `retireClock` in the M7 revision key turns unrelated urgent
### traffic into a suspense refetch storm (transition starvation)

Mechanisms defeated: M7 (lineage resources) × M2-clock (viewRevision) × M8
(retirement). The design states: "retirement conservatively changes every
later revision" — the global `retireClock` is a component of every capsule
key, so **any** retirement anywhere invalidates **every** suspense capsule's
next-pass identity.

Failing schedule (all steps ordinary; no adversarial user code):

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | transition k: `query.set("q")`; pass P1 evaluates `c` which calls `ctx.use(fetch(q))` (slow, ~2s) | M7 capsule stored under key `(…, revision R1 = {(k, clock_q)} + retireClock r0)`; P1 suspends; React shows fallback/pending |
| 2 | user clicks an unrelated button | urgent token U1 minted; `other.set(1)`; U1 renders, commits, retires |
| 3 | retirement/M2-clock | `retireClock` advances to r1 > r0 |
| 4 | fetch #1 settles | `settledAt` recorded; M5 settlement walk; React pings k's lanes |
| 5 | React retries k; new pass P2 | P2 copies revision R2 = {(k, clock_q)} + r1 ≠ R1 |
| 6 | `c` re-evaluates; position p | key mismatch → old capsule superseded ("once a newer revision exists… reclaimed") → **new** `fetch(q)` issued → P2 suspends on fetch #2 |
| 7 | user clicks again during fetch #2 | U2 retires; retireClock r2; goto step 4 |

Wrong observable outcome: while unrelated urgent interactions continue at a
rate faster than the fetch latency, the transition **never commits**
(starvation/livelock) and issues one duplicate network request per
interaction — user-visible over-fetch with side effects. This is exactly the
shape C15's trap warns about ("passSerial alone re-fetches forever"): the key
is stated, but its retirement component is global, so under steady traffic it
degenerates to per-pass identity. The design acknowledges the intra-token
write conservatism (C15 step 3) but nowhere acknowledges or gates the
global-retirement coupling. Note the same key feeds the sentinel capsule's
post-settlement "held success" — step 6 also re-runs a computation whose
successful box was already held, so even a settled-and-ready transition is
knocked back to pending by one unrelated click (walked from M7: "held in the
capsule until commit, view-revision… change").

Severity: HIGH (liveness + duplicate side-effectful fetches; no torn frame —
committed worlds stay correct). Judgment: **local fix** inside M7/M2-clock.
The revision's retirement component must narrow from the global clock to
retirements that changed *this view's* fold — e.g. key on the exact set (or
clocks) of tokens visible via the retired clause that were not already in the
include vector, or per-token retirement epochs. Only M4 (copy) and M7
(compare) consume viewRevision, so the repair does not touch frames, ledger,
walk, or fixup. Any repair must re-walk C15 step 6 and Docket 5.

### F2 — MEDIUM — retirement reconciliation is an unpriced O(watchers ×
### evaluation) synchronous stall

Mechanism: M6 ("At retirement, it reconciles reached watchers against each
root's committed view; already-correct watchers are not scheduled") — the
"already-correct" test requires a committed-for-root transient evaluation
per reached watcher, and M5's retirement walk starts from every atom the
token touched.

Schedule: token k writes one hot atom whose union cone reaches 10k committed
watchers (the design's own 10k-subscription scale); k retires; one JavaScript
turn performs 10k M2 folds + transient computed evaluations + boxed compares
before returning. The §7 gate table prices write delivery (SPK-N1), late
mount fixup (10k grid), and compaction — no row prices retirement
reconciliation, and it shares the turn with React's commit path. Cost-honesty
rule: unpriced hot-ish mechanism with a plausible frame-budget blowout.

Severity: MEDIUM (no wrong value; a measurable stall the design's own gate
discipline should have caught). Judgment: local — add a gate row plus an
amortization rule (e.g. skip evaluation when the watcher's last delivery
stamp already covers the retiring token's writes, or chunk reconciliation
behind the commit). Must not regress I14/C16 (retirement is the independent
committed-observer trigger) — the trigger must stay, only its evaluation cost
is at issue.

### F3 — MEDIUM — quiescence refresh × legal computed write = permanent
### episode-reset livelock (K1 never clears)

Mechanisms: M3 quiescence refresh × R8 write-in-computed policy (§12 allows
K0-computed writes when `forbidWritesInComputeds` is false and outside
render). M3: at quiescence every K1-touched watched node "is first refreshed
through newest K0… If such a refresh performs a legal computed write,
quiescence has ended and the reset aborts until the resulting batch retires."

Schedule:

| step | actor/mechanism | state touched |
| --- | --- | --- |
| 1 | setup | `configure({forbidWritesInComputeds:false})`; watched computed `c` whose fn legally does `counter.set(counter.peek()+1); return x.state` (acyclic; runs fine in DIRECT/donor) |
| 2 | any transition renders `c` once | `c` is K1-touched |
| 3 | all tokens retire → quiescence attempt | refresh evaluates `c` through newest K0 → legal write → `classifyAndClaimWrite` mints token → reset aborts |
| 4 | that store-only batch retires | next quiescence attempt → K1 still uncleared, `c` still touched → refresh runs again → writes again → goto 3 |

Wrong observable outcome: the episode never resets. K1 is add-only and now
never bulk-cleared, so speculative over-reach edges accumulate for the app's
lifetime (growing M5 walk cost and setter over-notification); `eventSeq`,
token serials, and input stamps never restart, making §3.6's saturation
fatal-throw the only terminus; every retirement now spawns one extra
background batch (churn). The design anticipated a single abort but not the
fixed point.

Severity: MEDIUM (needs an unusual-but-legal user computed; damage is
unbounded growth/churn, not a torn frame). Judgment: local — run refresh
evaluations under the fold-read/write prohibition (defer or reject the write
for the refresh evaluation), or exempt persistently-writing nodes and carry
their exact K1 edges into the next episode instead of refreshing them. Either
repair must re-walk the quiescence-safety argument in F6/attack notes below.

### F4 — NOTE — episode-reset sweep of K0 stamp/metadata columns is
### unspecified and unpriced

§6's counter table says node input/result stamps and per-source last-change
metadata "reset only after K1/frame clear plus episode bump," and the C13
walk restarts "event/input/walk counters" — but K0 nodes persist across
episodes, so this is an O(entire K0 plane) column sweep (or per-stamp episode
tags checked on read, which no section specifies). If an implementation skips
the sweep, a stale large `inputStamp` from episode E makes M3's catch-up
compare (`source.lastChangeSeq` vs `n.inputStamp`) silently skip a required
catch-up in E+1 — the Docket-2 hazard reopens (stale completed pass commits).
The mandated forced-small C13 tests would catch it only if they specifically
exercise M3 catch-up cross-episode; say so, name the sweep mechanism, and put
it in the compaction/reset gate row.

### F5 — NOTE — M5's discovery of provisional-watcher terminals needs a named
### structure

M5 "records the writer's token in that frame's catchupTokens" when the walk
reaches a node read by an uncommitted provisional watcher, and the cost row
includes "+ retained frames" — but no section names the structure that maps a
reached node to the open/completed frames that memoized it (per-reached-node
probe of every retained frame's memo table, or a node→frame index built at
memoization). The behavior is well-defined and priced coarsely; the structure
must be named or an implementer can build a walk that cannot find
frame-memoized terminals at all. No failing schedule once the stated behavior
exists in any form.

### F6 — NOTE — quiescence refresh scope wording: "with a committed watcher"

I verified (see held item 3) that the refresh rule is sound only under this
reading: K0-pull every K1-touched node that has a committed watcher **or a
`useSignalEffect` dependency snapshot**, relying on donor pull recursion to
recompute dirty upstream nodes and re-track their K0 edges (upstream
unwatched K1-touched nodes are covered because divergence implies a
canonical-dep write, I4, which dirties them in K0). The spec should state the
transitive-pull reliance and explicitly include effect-dependency nodes in
"committed watcher," or an implementer refreshing only `useSignal` watchers
leaves effect deps behind.

---

## Verified held (attempted and failed to break)

1. **C1 family, all seven, plus two variants the walk doesn't spell out.**
   (a) No pass between `flag.set` and `a.set`: no K1 edge exists yet, but W
   is already scheduled in k by the flag write's K0 walk, and the eventual
   k-pass folds both writes — no separate a-notification is needed. (b) A
   completed-but-uncommitted k-pass when `a.set` lands: the pass's own
   evaluation had inserted K1 `a→c`, the walk reaches W's setter under k, and
   protocol point 3 invalidates the completed pass before host mutation.
   Committed views never read a K0 value for a non-newest pass (structural
   routing, not per-node sensitivity).
2. **The post-completion write window (my strongest blocker candidate) —
   M4/M6/M8 seam holds.** Write lands after `renderLeave(complete)` but
   before commit, cone touching only a provisional watcher W mounting in the
   completed pass P: M4's catch-up dispatch point has passed and no committed
   setter exists. If the write's token is P's own k (async continuation): P
   commits, but `rootCommit` inserts k into `locked[root]` *before* layout
   effects, so M6 check 2's committed-for-root evaluation includes the
   post-pin write and issues the urgent correction **before paint** — no torn
   paint. If the write is an unrelated live urgent U: P's commit is
   consistent with the U-excluding committed world, and check 1's reach scan
   finds live U and `runInBatch(U, W.setter)` joins W to U's render. If U
   retired with no React work before P's commit: check 2 sees the
   retired-visible write and corrects pre-paint. The two checks compose to
   cover live-excluded / locked-included / retired exactly.
3. **Quiescence K1-reset cannot strand a divergent newest edge.** I tried:
   watched node d never K1-evaluated while upstream m is K1-touched and
   unwatched, so clearing K1 drops the only `x→m` edge. Defeated: divergence
   requires a canonical-dep write (I4), which dirties the K0 cone; any render
   that kept d's committed value current therefore could not use the K0 clean
   fast path and evaluated transiently — K1-touching d — and the refresh's K0
   pull recurses into dirty m and re-tracks `x→m` in K0 before the clear.
   Not-dirty nodes provably have current K0 edges (divergence ⇒ dirty).
   Held, subject to the F6 wording and the F3 livelock (if reset never runs,
   K1 is still present, so no correctness hole — only growth).
4. **§3.2 pass immutability, including ACTIVE_NEWEST.** Attempted mid-slice
   divergence: render writes throw before tape/K0 mutation (callstack-truth
   frame, C7-compatible); thenable settlement is microtask-only; staged
   function replacement advances no global eventSeq until winning commit;
   retirement fires from fork edges outside render functions. Yield swaps the
   closure before handlers run; a changed resume selects ACTIVE_VIEW and
   reconstructs pinned atom values from base+tape (compaction is blocked
   while any pass is open, so the base cannot move under the fold). Held.
5. **C2**: the flushSync frame is structurally non-newest (D live and
   excluded) → ACTIVE_VIEW → atoms fold to 0, computeds scratch-evaluate to
   10; K0's newest cache is unreachable from the frame. Held with no
   downstream-cone marking needed — the design's central bet works here.
6. **C3/S1**: fold parity re-derived at every step including the
   `set 5` overwrite variant and prefix-compaction blocking (a live earlier
   entry blocks a retired later entry). Matches React queue arithmetic.
7. **C4/C5/S14**: per-write full walks with no cross-write armed/dedup state;
   value-blind delivery means no canonical `changed` gate exists to lose the
   second batch (I5). The over-render price is explicitly gated (SPK-N1),
   with rejection-not-patch stated.
8. **C6**: per-write synchronous delivery in the writer's classified context;
   `batch()` defers only core-effect flush; no implicit grouping exists to
   forbid. Both legal transition/batch nestings walked.
9. **C7/S7/S12**: renderLeave(yield) restores newest reads for handlers; the
   click write sequences after the pass pins; resume re-selects ACTIVE_VIEW;
   `retiredAt`/`writePin` live on one eventSeq number line (I15 verbatim).
10. **C8/S8**: equal writes always get receipts; equality lives in donor K0
    cutoffs and reconciliation compares only.
11. **C9/S15**: staged nodes and their edges live under the frame watermark;
    M5 traverses retained frames' staged adjacencies; only the named winning
    pass promotes; abandonment resets the watermark — repeated
    mount-evaluate-abandon leaves no permanent arena record.
12. **C10/I18/S10**: walked including the retirement race (check 2 runs even
    with an empty live-token list) and joint divergence (reach-based, no
    per-token value compare).
13. **C11**: lock-in before effects; retirement stamps entries before
    removing tokens from root arrays in the same turn — no visibility gap for
    a view built between the two.
14. **C12/S4/S6 and O14**: receipts independent of subscription; carrier
    construction with parked claims; loud startup self-test for hosts without
    continuation identity.
15. **C13/I19**: every §6 counter has a retainer list and a reset/guard rule;
    forced-collision and forced-small tests mandated (modulo F4's sweep
    mechanism).
16. **C14**: replay cannot publish `previous`, re-fire fetches (same
    lineage+revision → same capsule), or double-start atom effects (microtask
    ticket); K1 over-reach from discarded passes is delivery-only and
    unobservable in values/effects.
17. **C15 quiet case and the react-concurrent-store known bug**: mount
    mid-transition while suspended reuses the same capsule/thenable (same
    lineage, unchanged revision); settlement preserves identity via
    `settledAt` ordering so old pinned frames still see pending. (The noisy
    case is F1.)
18. **C16/I14**: retirement is an independent trigger; the effect's committed
    dependency snapshot is retained until a changed committed fold, not a
    consumable dirty bit.
19. **C17**: no truncation surface exists.
20. **I16 closed change-source table**: I attempted unlisted inputs
    (`previous` publication without lineage change; equality-policy swap;
    compaction shape) — each lands in a row; fold-read and render-write
    prohibitions close the purity assumptions the replay induction needs.
21. **S13**: retention is O(union edges + actual live frames); no per-subset
    value structure exists to powerset.
22. **Fork honesty / rebase drill**: every fact the library consumes maps to
    one of the nine touch-points; M6's live-token scan reads a library-owned
    registry fed by edge-triggered mint/retire, not sampled reconciler state;
    yield/resume are explicit edges (C7); protocol point 3 is correctly
    stated as an obligation, not a work-loop timing assumption, and fork test
    9 pins it.

---

## Verdict

**Repairable.** Zero blockers: every battery case, scar, and round-2 docket
walk survived adversarial re-walking, and the design's central bet — no
reusable non-newest value caches, so no general validity predicate to get
wrong — eliminated the seams where prior candidates died. The one HIGH
finding (F1: global `retireClock` in the M7 capsule key causes refetch
starvation under ordinary unrelated urgent traffic) is a contained key-design
defect inside M7/M2-clock with a stated local repair path, and the two
MEDIUMs (unpriced retirement reconciliation; quiescence-refresh write
livelock) are rule additions that do not disturb the ledger, frames, union
walk, or fixup mechanisms — fix these and this architecture is
implementation-ready.
