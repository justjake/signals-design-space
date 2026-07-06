# Focused re-review — Program 2 revision (second pass) of the effects-unification + NF2 plan (fable)

Artifact: `plans/2026-07-06-effects-unification-and-nf2.md`, §3–§4 + §5/§6 as
they concern P2, REVISED second pass (plan commit `0101559`, terminology pass
`09d8fd0`). Scope per the re-review mandate (plan amendment 7): the revision
only — Program 1 is landed substrate (`3b0063a`), not re-reviewed. Grounding:
HEAD engine/adapter sources (`packages/cosignal/src/logged.ts` 3737 lines,
`packages/cosignal/src/index.ts`, `packages/cosignal-react/src/shim.ts`),
`spec/react-compliance-contract.md` (RCC-*), the spike report + archived
prototype, and the two prior reviews
(`reviews/2026-07-06-unification-nf2-plan-review-{fable,codex}.md`). Line
numbers below are today's HEAD. Terminology: prior reviews say "plane"; the
revision says arena / memo table / shadow arena — mapped silently.

Structure: §1 prior-findings checklist (each: CLOSED / PARTIALLY / UNADDRESSED,
with the revision's mechanism and my independent walk); §2 the three declared
retreats judged on their merits; §3 NEW findings the revision introduces,
ranked; §4 per-hole verdict table + recommendation.

---

## 1. Checklist — prior findings against the revision

### fable B1 / codex 3 — untracked-read coverage: **CLOSED**

Mechanism (§4.4.1): "an untracked read records a weak-flagged link in the
evaluating arena (one flag bit in the link record's spare field...),
unconditionally, exactly as HEAD's weak table does" — restoring both of HEAD's
mechanisms structurally: weak links participate in mark/PENDING propagation +
`wCheckDirty` (value validation, B1 mechanism 1) and in drain-candidate
expansion (mechanism 2), while the delivery walk skips them (HEAD parity —
verified: `deliveryWalk` never consulted `weakOutList`; only
`drainCommittedObservers` does, logged.ts:3422).

Independent walk of my B1 read-before-pending schedule: `C` reads `A`
untracked while committed-quiet; watcher `w` on `C` commits in R. At that
commit the §4.4.2 population rule fires — the re-staled loop
(logged.ts:3110-3115) committed-evaluates `C`; the first evaluation in R's
arena is necessarily a cold fold (nothing cached; and there is no cross-world
fast path any more, §4.4.8), so `node.fn` runs with the fn-reader and
`untrackedReader` (logged.ts:1811-1813, unconditional `recordWeakEdge` today)
records weak `A→C` into R's arena. T writes `A`, retires → site-(a) fanout
marks `A`'s shadow → PENDING propagates over strong AND weak links → `C` on
the dirty list → drain refolds → correction. Closed. The "recording is
unconditional, not pending-gated" fix is exactly where TAINT failed; TAINT
deletes at S-B with its last consumer (`sweepK1`'s keep-mask, logged.ts:2030).

Two subtleties checked and found sound:
- *Newest-no-weak-residue*: at HEAD, newest evaluations feed the shared weak
  table; under NF2 they record nothing. Safe because a committed consumer's
  own committed evaluations record the committed branch's weak links, and a
  branch the committed evaluation does not take cannot affect the committed
  value (discriminant argument, branch discriminants are themselves linked
  deps).
- *Cache-hit non-recording*: a clean shadow serves without running the fn and
  records nothing — safe because links persist in-place and a cache hit means
  the dep choice did not change.

One interlock the plan does NOT flag: this closure is load-bearing on retreat
(b) — see NEW finding N-4.

### fable B2 — committed-arena lifecycle: **CLOSED**

The three mutually inconsistent stories are replaced by one (§4.1): committed
arenas are permanent for the root's life (survive pass ends, retirements,
quiet mode, quiescence); "zero live worlds while quiet" is struck and replaced
by "zero live PASS arenas while quiet" plus flip site (d); the missing fourth
fanout site (quiet fold) is added, not argued away.

Both of my resolution schedules now walk green as the plan claims:
- Resolution-1 (quiet write after quiesce): `__quietWrite`
  (logged.ts:2333-2352) advances `base/cas`, then site-(d) fanout marks the
  atom's shadow in every live committed arena before `quietDrain` /
  `revalidateCommittedSubs(undefined)` evaluate committed worlds — the marks
  are visible to both. `quiet-mode.spec.ts` shape survives.
- Resolution-2 (post-quiescence write): `quiesce()` (logged.ts:3634-3702)
  loses its kernel-pull refresh with nothing in its place because nothing is
  needed — arena links are current structure, not an episode log; at
  quiescence the residue assert proves tapes are empty, so committed == newest
  for every root and the persistent links/values stay consistent. The
  delivery walk over kernel ∪ live arenas finds `A→C` in R's surviving arena.

The replacement is genuinely a replacement (persistence), not a substitute
mechanism — correctly stated. PR1 accounting verified: `memoTableOf` never
creates root records (logged.ts:1524-1527) and arenas materialize only at a
committed evaluation, which requires a consumer, so a consumer-less app's
quiet write pays exactly one `arenasLive` scalar check. Costs of permanence
are retreat (c), judged in §2; two per-row lifetime-table qualifications are
NEW findings N-6/N-7.

### fable B3 — fp-gated mark consumption at lock-in: **CLOSED**

Mechanism (§4.2): the fp decision procedure is split per flip site. Sites
(a)/(c)/(d) are monotone-max — verified against code: retirement mints
`retirementStamp` above every prior seq and `fpOf`'s floor includes it
(logged.ts:3237-3263, 1408), so even a below-max receipt becoming visible at
retirement moves fp via the stamp; a member write appends a new maximum
(logged.ts:2469-2479); a quiet fold advances `baseSeq` (2342). Site (b)
NEVER fp-gates: "Every atom marked by a lock-in fanout REFOLDS
unconditionally and value-compares... fp serves only one-directionally" —
exactly the carve-out B3 demanded, with the seq-50-under-100 shape pinned
(§4.9.3) and the "replaces commit-generation re-keying" claim re-stated
honestly ("only TOGETHER with refold-always at (b)"). Completeness argument
checked: lock-in of T flips visibility of exactly T's receipts (membership
clause, `visibleAt` logged.ts:1455-1460), which live on exactly
`T.atomsTouched` (maintained per write, logged.ts:2474-2477) — refolding the
fanned set is the whole flip. m4's per-token placement is in the text
("inside the per-token loop, not once per commit"). Cost of refold-always on
wide masks: analyzed, bounded, gated — NEW finding N-11 (NOTE) only.

### fable M1 — committed-arena population rule: **CLOSED**

§4.4.2 names the rule first-class with four populators, the two previously
unnamed carriers now declared and protected: (1) the `passEnd` re-staled
detection loop — verified it committed-evaluates every rendered watcher's
node at every commit including mounts (`mountWatcher` adds to `p.rendered`,
logged.ts:2687; `w.live` is set at 3102 before the loop at 3110-3115; the
loop runs BEFORE `reclaimAfterPassEnd` at 3118, satisfying m2's ordering) —
"hereby DECLARED load-bearing for routing", with a dev assert and my walked
schedule pinned; (4) the shim's reveal compare (`resubscribeAtLayout`'s
`committedValue` call, shim.ts:793) named and kept. The bootstrap
circularity closes: a watcher's committed cone enters the arena at the very
commit that makes it live, before any post-commit write needs routing.
Commit-time link migration is rejected on the correct ground (pass dep
choice ≠ committed dep choice — battery case 1), and the re-derivation cost
is one the engine already pays. M1's sharpening (one shared structural
source; a routing miss is stale-until-cone-motion, not a lane demotion) is
adopted verbatim in §4.4.4 and R2. Residual nit: the post-commit assert
checks node-shadow existence, weaker than the "full cone" prose — NEW
finding N-9 (NOTE).

### fable M2 / codex 5 — suspense settlement per arena: **CLOSED in mechanism, two new §4.5.4 gaps found**

The settlement re-mark site exists (§4.5.4): one bridge-registered hook on
the kernel's D5 primitive `invalidateComputed` (index.ts:1210-1222; verified
"already called by every ctx.use settle listener" via `attachSettle`,
index.ts:1790-1813), walking live arenas — pass arenas included via §4.3's
pin-exempt settlement mark, whose RT1/SU5 defense I checked against the
contract's letter and accept (RT1 quantifies over state/receipts; SU5
demands retry progress; L4 entries are shared across views by key). My M2
schedule now walks green: sentinel cached in R's arena; K settles → re-mark
→ the next boundary re-check refolds → sentinel→value IS a flip → refire.
Pins named (engine re-mark + React-battery background-settlement case,
RCC-SU5 cited).

However the revision specifies only the PUSH half of what the kernel needed
two halves for, and under-specifies the hook's firing context — NEW findings
N-2 and N-3 (both MAJOR). Also the plan's "FIXES a pre-existing HEAD gap" is
half-right at best: at HEAD, overlay world evaluations never cache sentinels
at all (a throwing evaluation stores no memo — `evaluate` stores only on
successful return, logged.ts:1762-1767; `revalidateCommittedSubs` catches
the throw, 2983-2988), so every re-check re-runs the fn and picks up
settlement for free. NF2 *introduces* the background caching (§4.5.4 stores
the sentinel in the arena value column) and the re-mark is the new
mechanism's own necessary companion, not primarily a HEAD repair. The
kernel-path variant of the HEAD gap may exist; the overlay claim as written
overstates.

### fable M4 — honest collapse claim: **CLOSED** (P1-landed)

§5.1 restates it as ruled: "3 indices became 1 index + 1 root list, not 1;
both survive P2 unchanged". Verified in code: `watchersByNode` +
`subsByNode` (logged.ts:992) for deliver/newest collection; `run/committed`
subscriptions re-check by root-scoped full scan (`revalidateCommittedSubs`,
2972-2996), collection-free.

### fable M6 — obsCapture in the transliterated walks: **CLOSED**

P1 landed the pre-dedup placement (verified: `recordEdge` captures before
the episode dedup, logged.ts:1833-1838, with the load-bearing comment).
§4.7 carries the discipline into `wLink` explicitly ("every dependency read
through the same capture hook AT THE READ, before `wLink`'s reuse cursor
logic — mirrored comment at both sites"), and my demanded schedule
(world-divergent deps; drive a committed re-evaluation through the WORLD
path; assert the retain re-points) is pinned as an ENTRY GATE for S-C
(§4.8, §5 gate iv). R4/R9 fold the residual tripwire correctly.

### fable m1 — S-A honest contents: **CLOSED**

§4.8 S-A adopts the restatement ("this is the majority of NF2's new
write-path logic, not a value-store stub"), lists arenas + folds + ALL FOUR
flip sites + settlement re-mark + equality record as mandatory in-stage,
states the divergence detector explicitly (lockstep per-op world snapshots +
exact correction/effect streams; the validator checks each graph internally)
and the mid-stage STOP rule. R3/R6 carry the same wording. Residual
suggestion (free strengthening, not a defect): NEW finding N-8 (NOTE).

### fable m2 — arena drop vs fixup ordering: **CLOSED**

§4.1 pins pass-arena drop in `reclaimAfterPassEnd`, "which already runs
AFTER mount fixup and after the re-staled detection loop", with the dev
assert (touching a dropped arena throws). Verified against `passEnd`:
fixup at 3099-3104, re-staled loop at 3110-3115, reclaim at 3118.

### fable m3 — delivery-precedes-correction fuzz invariant: **CLOSED**

§4.4.6 scopes it to "corrections caused by member-slot writes newer than
the watcher's last render" and excludes quiet-mode corrections,
mount-window repairs, older-write visibility flips, and the S-NF2-D1
family — my counterexample list, adopted in full.

### fable m4 — per-token lock-in fanout: **CLOSED**

§4.3(b): "fan THAT token's `atomsTouched` into THAT root's arena, per
locked-in token (m4 ...); the fanout runs inside the per-token loop, not
once per commit". Matches the `maskTokenRecords` loop shape
(logged.ts:3079-3096).

### fable m5 — registration-guard enforcement split: **CLOSED** (P1-landed)

§4.0 records the split as landed; verified: core enforces the
evaluation-frame half (`captureRun` throws at `evalDepth > 0`,
logged.ts:2850); the render-stack half stays adapter-enforced.

### fable m6 — write-free retirement gating: **CLOSED** (P1-landed)

§4.0: retirement/settlement subscription scans run unconditionally even
write-free — verified (`retire`/`settleAction` →
`revalidateCommittedSubs(undefined)`, logged.ts:3201/3216, the latter
commented "settlement is a guaranteed flush point") — and P2 keeps every
boundary call, so motion-implies-boundary holds by construction. One NF2
erosion of the watcher-drain gate's O(1)-quiet property is NEW finding N-5.

### codex 4 — dead-arena batch-attribution gap: **RETREATED, not closed** — judged in §2(a)

### codex 6 — per-world equality: **CLOSED, one reuse hazard attached**

§4.5.3 makes the record shape explicit: raw getter + comparator in side
columns keyed by kernel id; arena-local previous value (never the kernel
slot); exceptional-outcome bits mirroring the kernel's box discipline.
`wUpdate` keeps `prev`'s reference on unchanged (codex 6's reference-
preservation counterexample, pinned ×3 arenas); equality never bridges an
exceptional boundary. Pre-S-C overlay computeds keep `Object.is` — verified
that is today's overlay memo-compare semantics (logged.ts:1596). The
kernel-id keying, however, walks into the kernel's free-list id reuse
unguarded — NEW finding N-1 (MAJOR), which also covers arena shadows
post-S-C.

### codex 7 — S-A executability / temporary newest representation: **CLOSED**

§4.8 S-A: "`newestMemos` + the newest arm of `validateMemo`/`fpOf` SURVIVE
S-A and S-B... only the pass/committed arms ... delete now", so newest
reads, core-effect flushes, and obsEnter discovery (the forced newest
evaluation, logged.ts:1885-1900) keep working until S-C; R6 budgets the
two-thirds-true ladder claim and §4.10 counts it. The dual-bookkeeping
critique is answered by re-scoping what it compares (value-store comparison
via lockstep, not migration atomicity) and by keeping K1 routing through
all of S-A so routing failures cannot hide behind value failures — S-B is
then a routing-only diff policed by the exact streams. This is the honest
version of the original claim, and it is executable.

### codex 9 — the two ordering couplings: **CLOSED**

First coupling dissolved by the EF2 ruling itself (the member-write
immediate scan is gone; site (c) only marks at the write-path lines that
set `committedDirtySlots`, logged.ts:2480-2487, and the next boundary
flushes); the surviving joint is §4.3's per-site order (mutate → fan →
drain → ... → `revalidateCommittedSubs` → `flushNotify`), which matches the
landed code shape (drains inside the per-token loop at 3094 / inside
`retireInternal` at 3277; sub scans at 3125/3201/3216; `flushNotify` last),
with one pinned ordering test per site. Second coupling: landed pre-dedup
`obsCapture` (1833-1838) + §4.7's wLink discipline + the M6 entry-gate pin.

### codex 10 (P2 half) — lifetime classification: **CLOSED in form**

§4.6 provides the mandatory table with a derived-of column and per-row
teeth; the two first-pass resisters are resolved via derived-of. Three rows
have defects found by walking their teeth — NEW findings N-1, N-6, N-7.

---

## 2. The three declared retreats, judged

### (a) Dead-arena delivery gap → value-correct-lane-degraded (S-NF2-D1): **ACCEPTABLE RETREAT** — the SP4/SP5 defense survives my own reading of the letter

I checked the plan's contract defense against the contract text directly,
not against the plan's paraphrase:

- **SP5's MUST half** ("MUST never fail to notify a consumer whose view of
  what it rendered changed", contract:499-506): at U's pending write, the
  watcher's rendered view is committed truth (flag=false → the `b` branch);
  U is live and unrendered by `w`, so nothing `w` rendered changed. No
  notification is owed at that instant. When the view durably changes (T's
  commit flips `flag` committed; U's own commit/retirement moves `a`
  committed), site-(b)/(a) fanout marks, the refold re-tracks `c`'s links,
  and the drain's EXACT-stream correction notifies. The MUST half is met at
  every point where it binds.
- **SP5's second MUST** (rendered output value-correct): corrections are
  urgent pre-paint re-renders (queue kind 2 → `onCorrection`), so no frame
  paints the stale value once the flip is durable. RT5/RT6 hold.
- **SP4** ("Work the library schedules on a batch's behalf ... is scheduled
  INTO that batch's own lane", contract:494-498): SP4 constrains the LANE
  of scheduled work; it does not itself mandate that work be scheduled
  (that is SP5's job). In the gap the library schedules nothing at U's
  write, so SP4's letter is not engaged. What is genuinely lost vs HEAD is
  the SPIRIT of SP4 for exactly this family: `w` no longer rides U's lane
  and instead pays one extra urgent correction render after the durable
  flip. That is precisely "value-correct, lane-degraded".

I also stress-tested the family beyond codex 4's original interleaving: if
U's write lands while T's RESTARTED pass is open, the pass arena holds the
fresh `a→c` link and the walk delivers into U normally (pass arenas
participate in the §4.4.3 walk) — the gap is exactly the no-open-pass
window, as declared. If U locks into R before T restarts, the site-(b)
fanout of `{a}` no-ops (no `a` shadow — and correctly so: committed `c`
does not yet depend on `a`), and the eventual T-commit refold reads U's
already-committed `a` — final value correct in one correction. All three
pinned interleavings converge.

Remaining honest characterization, which the plan itself adopts from M1's
sharpening: because deliveries and drain candidates now share one
structural source, this is a documented forever-residual, guarded only by
pins (the ⊆ delivery tolerance means lockstep will never flag it). The
pins with documented degraded-but-correct outcomes are the right teeth.
Verdict: a legitimate, declared, correctly-defended parity trade — not
disguised unsoundness.

### (b) World-read fast path deleted (cold-pass gate + TODO(perf) re-entry): **ACCEPTABLE RETREAT**, with one interlock to write down

The deleted mechanism (logged.ts:1700-1710: touched word 0 ⇒ serve the
validated newest memo to any world) is priced honestly: the spike prototype
had no cross-world fast path at all — every world read routed to its arena
(spike report: `Atom.state`/`Computed.state` route while a world evaluation
is open) — so the published parity numbers (discard churn −4.3%/+0.8%; the
none-dirty revalidation row 12.0→16.7 ns visible in the spike table)
already include the deletion. The revision adds an explicit cold-pass gate
(N≈200 quiet computeds, first render, §4.9.6) plus the N2 cycling shape,
and records the re-entry TODO instead of pretending the cost away.

Two qualifications:
1. The deletion is not only a cost — it is LOAD-BEARING FOR CORRECTNESS of
   §4.4.1/§4.4.2: with no fast path, the first committed evaluation of any
   consumer cone is a cold in-arena fn run, which is what records the
   strong AND weak links the whole coverage argument stands on. A future
   "provably quiet" re-entry that serves values without recording arena
   structure resurrects B1/M1 silently. The TODO(perf) text must carry
   this constraint — NEW finding N-4.
2. The gate is one bench shape; a regression there triggers "the follow-up"
   — acceptable, since the follow-up is recorded as a seam and RUL-3
   already conditions landing on the profile question.

Verdict: acceptable; simpler-and-priced beats clever-and-unsound here, and
the retreat is what makes the B1 closure self-sufficient.

### (c) Permanent committed arenas (the many-root residual): **ACCEPTABLE RETREAT**, with the memory story incomplete in two specifics

The structural residual (R arenas × 32–64 KB at bench shapes + one fanout
branch per changed write per live arena, dedup-bounded) is measured,
published, and gated (R=4 idle scaling + the cycling shape that resets the
dedup — N2 adopted). Lazy materialization is real (verified: nothing
creates a root record or arena without a committed consumer), so the
zero-consumer PR1 story holds at one scalar check.

What R5 does NOT yet price, both flowing from permanence:
- **Value-column retention**: at HEAD, `quiesce()` clears every root's
  committed memos (logged.ts:3675) — cached derived values (which can pin
  arbitrarily large app objects) are freed at every quiescence. Under NF2
  they live for the root's life. This is a retention-class delta, not a KB
  of Int32Array — NEW finding N-6.
- **The destroy event**: "die only with the root record (host teardown) or
  bridge disposal" — there is no root-teardown path in the engine at HEAD
  (nothing ever deletes from `this.roots`), so in practice arenas die at
  bridge dispose only. The lifetime-table row cites a destruction event
  that does not exist — NEW finding N-7.

Verdict: acceptable as a performance residual; the two specifics are
one-sentence-each fixes to R5/§4.6 plus one recorded option, not design
rework.

---

## 3. NEW findings introduced by the revision (ranked)

### N-1 (MAJOR) — kernel-id reuse vs permanent arenas and the §4.5.3 side columns: the S-C identity re-key walks into the kernel's free list unguarded

**Plan text attacked:** §4.8 S-C "Node identity re-keys to kernel ids — the
§4.5.3 side columns are already keyed that way"; §4.5.3 "a side column
keyed by kernel id"; §4.1 committed arenas permanent.

**The hazard the kernel itself documents:** kernel node records are
free-listed and REUSED (`nodeFreeHead`, index.ts:398), and the kernel keeps
a GEN field precisely because of it ("bumped on free so disposers can
defuse stale ids", index.ts:290/317). The spike's shadow records carry NO
generation defusing — the spike repurposes the shadow's GEN field slot to
store the kernel id itself (spike code index.ts:2301) — and the spike never
ran the dispose-then-reuse-under-a-long-lived-world shape (its teardown
coverage was world teardown + the unwatched-dispose cascade, not id reuse
against a surviving arena).

**Failure schedule (mainstream, not exotic):** post-S-C, `useComputed`
keeps its deps-keyed contract (WP3) — deps change ⇒ the old kernel computed
is disposed (unwatched reverse-dispose), its record freed, its id reused by
the replacement (or any later node). Root R's PERMANENT committed arena
still holds shadow[id] with the old node's cached value, links, and — if
the old node had custom equality — the §4.5.3 side columns still hold the
OLD rawFn/equals under that id. The new node's first committed evaluation
finds a clean-flagged shadow ⇒ serves the dead node's cached value; or, on
refold, runs the dead node's rawFn/comparator. Wrong value, wrong function,
silently. Pass arenas are exposed too (dispose runs at operation
boundaries, which a multi-op pass spans), but the permanent arenas make it
unavoidable rather than a race.

**Demand:** an id-tenancy discipline mirroring the pool's claim
generations, named in §4.5.3/§4.6/§4.8: per-shadow (and per-side-column
entry) kernel GEN stamps validated at serve/walk time, or a bridge hook on
kernel free that purges the id from every live arena + side column; plus a
pinned dispose-reuse-read schedule as an S-C ENTRY GATE alongside the M6
pin. Pre-S-C stages are safe (overlay node ids are never freed — logged.ts
has no node disposal — which is also why HEAD never had this bug to teach).

### N-2 (MAJOR) — §4.5.4 specifies the push half (settle hook) but not the pull half (read-site self-heal) that the kernel needed for determinism

**Plan text attacked:** §4.5.4's claim that the settle-time re-mark makes
the retry and the next boundary scan see the settled value, full stop.

**Why the kernel has two halves:** the kernel's own boxed-read tail
self-heals a settled-but-not-yet-invalidated suspension at the READ
(index.ts:1827-1842), with the stated reason: "so a read after `await` is
deterministic even before the settle listener's microtask runs". The
revision gives arenas the caching (sentinel + box-suspended bit in the
value column) and the microtask-driven re-mark, but no serve-time
`t.status` check.

**Failure schedule:** committed evaluation of `C` suspends on key K;
sentinel cached in R's arena. `await K` in app code; in the continuation
(a microtask whose ordering against the hook's `t.then` callback is not
guaranteed — and is definitively lost for custom thenables that were
settled before the hook attached), read `committedValue(C, R)`: the shadow
is clean, the box serves ⇒ the read observes pending AFTER settlement. At
HEAD this cannot happen for overlay computeds — nothing caches the
sentinel, so the re-check re-runs the fn and hits `ctx.use`'s settled
entry. RCC-SU5's letter ("a settled resource reads synchronously in every
view that may see it") is violated by NF2 in a window HEAD does not have.

**Demand:** an arena boxed-serve rule transliterating index.ts:1827-1842 —
serving a box-suspended shadow first checks the thenable's status; settled
⇒ self-invalidate (mark + refold) before serving — plus a pinned
read-after-await engine schedule. One paragraph in §4.5.4; without it an
implementer ships the push half only.

### N-3 (MAJOR) — the settlement hook's firing context is under-specified: `invalidateComputed` fires synchronously inside open evaluations, not only from settle microtasks

**Plan text attacked:** §4.5.4 "the kernel's D5 settlement-invalidate
primitive ... gains ONE bridge-registered hook", described only via the
settle-listener path.

**The other callers, in code:** (i) `boxedRead`'s self-heal calls
`E.invalidateComputed(c)` synchronously DURING a read (index.ts:1836) —
reachable while a world evaluation frame or a drain's compare loop is open;
(ii) `attachSettle` runs inside `storeThrown` inside an evaluation, and
`t.then(onSettle, onSettle)` on a custom (non-Promise) thenable may invoke
`onSettle` synchronously in that same stack. In both cases the hook would
mutate arena flag columns and dirty lists (mark DIRTY + propagate PENDING)
while a walk over the same arena may be mid-flight — the exact interleaving
the kernel handles explicitly by branching on `runDepth`
(`propagate(subs, runDepth !== 0)`, index.ts:1218).

**Demand:** specify the hook's re-entrancy rule: either defer the re-mark
to the operation boundary when `evalDepth > 0` (a one-slot pending queue —
marks are idempotent), or carry the kernel's dual-mode propagate discipline
into the arena propagate and say so at both mirror sites; plus one pinned
schedule (settled custom thenable read inside a drain compare). Without a
stated rule the validator/fuzz will find flag-state corruption at S-A and
stop the stage on a question the plan should have answered on paper.

### N-4 (MINOR) — the §4.4.8 TODO(perf) re-entry seam, implemented naively, resurrects B1/M1

The recorded follow-up ("a kernel-side fast path for provably quiet reads")
is stated as a pure-performance seam. It is not: any cross-world serve that
skips the cold in-arena fn run also skips strong/weak link recording, and
§4.4.1/§4.4.2's whole coverage argument grounds in that first cold run
(§1-B1 above). Schedule: mount `C = f(untracked A)` in R with the future
fast path serving C's first committed read from the newest cache ⇒ no weak
`A→C` in R's arena ⇒ T writes A, retires ⇒ fanout finds no shadow/link ⇒
no candidate ⇒ stale — B1 verbatim. Fix: one sentence in the TODO text —
value-serve is legal only when the arena already holds the node's links
(structure recording may never be skipped) — so the constraint travels with
the seam to whoever implements it under bench pressure.

### N-5 (MINOR) — unconsumed marks on consumer-less cones accumulate forever; the drain gate and per-boundary cost erode

§4.3's keep-the-dirt rule ("a mark may never clear without its refold
having run"; drains re-append still-marked entries) is right for
correctness, but a cone whose consumers all unmounted is never evaluated
again: its marks re-append at every drain, every boundary, for the root's
(permanent) life, and the "dirty list non-empty" drain gate degrades toward
always-true — eroding the write-free-boundary O(1) property m6 pinned, and
adding O(dead entries) rescan per drain in long-session apps that grew and
shrank. Safe alternative the plan should name: an unconsumed mark MAY clear
if it also evicts the shadow's cached value (drop to cold — evict-don't-
serve is exactly the `validateMemoInner` rule's shape), which preserves the
never-serve-stale property without the immortal re-append. Or accept and
add a grown-then-shrunk bench shape. One paragraph either way.

### N-6 (MINOR) — committed-arena value columns retain derived app objects across quiescence; HEAD frees them there

At HEAD every quiescence clears the per-root committed memo tables
(logged.ts:3675), releasing cached derived values (potentially large app
objects whose consumers are long unmounted). Permanent arenas retain the
value columns indefinitely. R5 prices structure (32–64 KB Int32Array) but
not payload retention. Fix: state the delta in R5 and record the option of
a quiesce-time value-column sweep (keep shadows/links — routing coverage,
§4.1's whole point — drop values to cold; they refold on demand), decided
by measurement like the read-clock fallback.

### N-7 (MINOR) — the committed-arena row's destroy event does not exist in code

"Destroyed: with the root record / bridge dispose" — the engine never
deletes root records (no teardown path exists at HEAD; `quiesce()` keeps
them). Either the row should honestly say "bridge dispose (no root
teardown exists; adding one is out of scope)" or a root-unmount teardown
becomes a named P2 deliverable. As written, the table's teeth for this row
cannot be exercised by any test.

### N-8 (NOTE) — the S-A additive window could cross-check ladder-vs-arena directly, nearly for free

During S-A's additive commits both value stores are live; the plan routes
all divergence detection through lockstep + exact streams (stated, per m1).
A dev-mode assert comparing arena serve vs ladder serve per evaluation
during that window would localize a fold/fanout bug to the exact node and
op instead of to a model diff. Cheap, temporary, worth a sentence.

### N-9 (NOTE) — the §4.4.2 population assert is node-level; the prose claims cone-level

"every live `w ∈ p.rendered` has a shadow for its node in the root's
arena" does not assert the recursive cone the paragraph's populating claim
makes. The pinned M1 schedule covers the cone behaviorally; either widen
the assert to sampled cone-membership or say node-level in the prose.

### N-10 (NOTE) — arena boxed-serve semantics (throw vs return) unstated

Pre-S-C the effect scan's 16d arm catches a THROWN `SuspendedRead`
(logged.ts:2983-2988); §4.5.4 has background evaluations STORE the
sentinel; §4.5.3's cutoff treats value↔box as changed. Whether a
box-suspended shadow's serve rethrows (boxedRead-style) or returns the
sentinel changes which arm the scan exercises. One sentence; the pinned
16d twin will force the answer anyway.

### N-11 (NOTE) — refold-always at site (b) moves fold cost into React's commit phase; bounded and gated, but name it in R5

Lock-in fanout with refold-always pays O(|atomsTouched ∩ cone-shadows|)
folds inside `passEnd(commit)` (layout timing), where HEAD paid O(1)
(commitGen++) and deferred refolds to reads — but HEAD's same boundary
already committed-evaluates every rendered watcher through gen-evicted
memos (full cone refold), so NF2 is plausibly cheaper net; the §4.9.6
cycling shape is the right gate. Recorded so S-D doesn't mis-attribute a
commit-latency delta.

---

## 4. Per-hole verdicts and recommendation

| prior hole | verdict on the revision |
|---|---|
| fable B1 / codex 3 (untracked coverage) | CLOSED — per-arena unconditional weak links restore both HEAD mechanisms; both prior schedules walk green; interlock with retreat (b) noted (N-4) |
| fable B2 (arena lifecycle) | CLOSED — one story (permanence), fourth fanout site added, struck invariant replaced honestly; both B2 schedules walk green |
| fable B3 (fp at lock-in) | CLOSED — refold-always at (b), fp one-directional; monotone-max claim for (a)/(c)/(d) verified against `retirementStamp`/`fpOf` floors; pinned shape named |
| fable M1 (population rule) | CLOSED — populators named and declared load-bearing; re-staled loop ordering and mount inclusion verified in code; migration correctly rejected |
| fable M2 / codex 5 (settlement) | CLOSED in mechanism — re-mark site + pin-exempt pass-arena mark, contract defense checked; but §4.5.4 ships only the push half (N-2) with an unstated firing context (N-3) |
| fable M4 | CLOSED (P1 landed; §5.1 restated honestly) |
| fable M6 / codex 9 second coupling | CLOSED — pre-dedup capture landed; wLink discipline + S-C entry-gate pin |
| fable m1 (S-A contents) | CLOSED — honest scope, stated detector, STOP rule |
| fable m2 (fixup ordering) | CLOSED — verified against passEnd order; dev assert pinned |
| fable m3 (fuzz invariant) | CLOSED — scoped to my counterexample list |
| fable m4 (per-token fanout) | CLOSED |
| fable m5 / m6 | CLOSED (P1-landed; §4.0 records both; m6's gate erosion under NF2 → N-5) |
| codex 4 (dead-arena gap) | RETREATED — accepted; SP4/SP5 defense independently verified; S-NF2-D1 pins are the right teeth |
| codex 6 (equality) | CLOSED — four-part record, reference preservation pinned ×3; kernel-id keying inherits N-1 |
| codex 7 (S-A executability) | CLOSED — temporary newest representation survives to S-C, budgeted |
| codex 9 first coupling | CLOSED — dissolved by the EF2 ruling; surviving joint pinned per site |
| codex 10 (P2 lifetime table) | CLOSED in form — three rows qualified (N-1, N-6, N-7) |

**Retreats:** (a) dead-arena gap — acceptable, correctly defended under the
contract's letter, pinned; (b) fast-path deletion — acceptable and priced by
the spike's own no-fast-path numbers plus a new gate, with the N-4
constraint to be written into the TODO; (c) permanent arenas — acceptable
as a measured residual, with the memory story needing N-6/N-7's two
sentences. None is disguised unsoundness.

**Recommendation.** The revision does what a design revision should: every
blocker got a mechanism with a walked schedule (not a tolerance), the three
places it could not match HEAD are declared retreats defended under the
contract's letter and pinned so regressions and fixes both diff loudly, and
the enlarged S-A is honest about being the majority of the new write-path
logic while keeping K1 routing as the isolation harness. I find no blocker
in the revised design as staged: **implement staged** — S-A/S-B may proceed
once RUL-3 is answered, on the plan's own gate list — with the following
folded in first as text amendments and entry gates rather than another full
design pass: (1) N-2 and N-3 amended into §4.5.4 before S-A (both are
paragraph-sized specifications of machinery S-A builds; leaving them to
implementation-time improvisation is how B1-class holes happen); (2) N-1
made an S-C ENTRY GATE beside the M6 pin (id-tenancy/GEN discipline + the
dispose-reuse pinned schedule) and one sentence added to §4.5.3/§4.8 now so
the re-key isn't specified unguarded; (3) the one-line fixes N-4 (TODO
constraint), N-5 (evict-alternative or bench shape), N-6/N-7 (R5/§4.6
wording) applied editorially. No new owner rulings are required beyond the
already-queued RUL-3/RUL-4; nothing found reopens the EF2/OL1 rulings or
the P1 substrate.
