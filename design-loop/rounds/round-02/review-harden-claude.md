# Review — design-harden.md (round 2) — Claude reviewer

Scope: adversarial correctness review per `SEEDS/prompts/reviewer-claude.md`.
I re-walked C1–C17 against the design's own mechanisms, attacked every
by-construction claim, and probed mechanism seams (fingerprints × folds,
flags × cutoffs, fixup × commit ordering, staging × fn identity, counters ×
episodes). Findings first, most severe first; every finding carries a
concrete failing schedule. Then verified-held claims, then the verdict.

---

## F1 — BLOCKER (local fix): the atom fingerprint is blind to visibility
## flips beneath its max; cross-world fingerprint compares validate changed
## folds (missed effect re-runs; stale thenable replay = torn commit)

**Mechanisms defeated:** §8.3 `fp(atom,w) = max(newest w-visible entry seq,
baseSeq, reducerStamp)` × §8.2 ladder × §11.4 effect dep snapshots, and ×
§9.2 thenable prefix validity. The §8.1 table's S2 row (observer: "epoch +
baseSeq monotonicity") and S6 row ("world identity lives in the KEY, never
a conjunct") are both wrong for the two retainer kinds that re-materialize
their world at every check — effect snapshots (fresh committed-for-root per
flush) and thenable prefixes (fresh pass world per retry). For those, a
visibility change (retirement's retired-clause flip, or per-root lock-in
mask growth) is a change source with **no observer**: epoch may not bump
(lock-in), the slot clock predates the snapshot, and the fingerprint does
not move when the newly visible entry's seq is below an already-visible
newer entry. `max` is monotone but not injective over the visible set; the
B1 repair fixed regression, not injectivity. The design itself overclaims at
§8.3: "MOVED for worlds that newly see it via the retired clause" — true
only when the newly seen entry IS the max.

**Schedule A (missed effect re-run; C16/C12 class; no corrective exists):**

```
setup | atom a=0 (empty tape, baseSeq 0); root R; useSignalEffect E reads a;
      | E's snapshot: deps [(a, fp=0)], r.seq=t0, r.epoch=e0
1 | transition k1: a.update(x=>x+5)  | tape+={+5,k1,s1}; wc[k1]=s1
2 | transition k2: a.update(x=>x*3)  | tape+={*3,k2,s2}; s2>s1
3 | k2 renders first, commits on R   | lockedIn(R)|={k2}; §11.4 trigger 1:
  |                                  | w=(({k2}),pin): visible={s2} (k1 ∉ mask,
  |                                  | unretired); predicate: wc[k2]=s2>t0 →
  |                                  | invalid → ladder: fp(a,w)=max(s2,0,0)=s2
  |                                  | ≠ 0 → re-run: E sees fold 0*3=0.
  |                                  | New snapshot [(a, s2)], r.seq=t1>s2.
  |                                  | (React parity ✓: k2 skips k1, rebases —
  |                                  | committed shows 0.)
4 | k1 commits on R (and retires; or | committed world now folds {s1,s2} in seq
  | multi-root: lock-in only)        | order: (0+5)*3 = 15. Trigger 1 fires:
  |                                  | clocks: wc[k1]=s1 ≤ t1 → PASSES;
  |                                  | epoch: if k1 retired, bumped → ladder:
  |                                  | fp(a, committed) = max(s2, bS, 0) = s2
  |                                  | == recorded s2 → REVALIDATE, no re-run.
outcome | committed world moved 0 → 15; E never re-runs. E last observed 0;
        | DOM (watchers, value-compared) shows 15. An effect syncing a to a
        | server/localStorage holds 0 forever. Every predicate layer passes:
        | clock (write predates snapshot), epoch (ladder's job to survive),
        | fingerprint (max capped by s2). No backstop covers effects.
```

Compaction is not required (the same arithmetic holds pre-compaction via
the retired clause: s1 newly visible, max still s2), and the lock-in-only
variant on a multi-root app never even bumps the epoch. The design's own
B1 walk (§8.4) and C16-B1 only test the single-entry case where the newly
visible entry is the max.

**Schedule B (stale thenable replay — the exact I20 tear, torn commit):**

```
setup | a=0; default batch D: a.set(5) → {set5,D,s1}, D pending (∉ any
      | transition mask); transition k: a.update(x=>x+1) → {+1,k,s2}, s2>s1
1 | k's pass (mask{k}, pin p1): c evaluates | fold a = 0+1 = 1; c fetches
  |                                         | user thenable th(1); suspends;
  |                                         | cache entry (c,Lk,0) records
  |                                         | prefixDeps=[(a, fp=s2)]
2 | D commits+retires (retiredSeq r_D)      | committed a moves; k's retry
  |                                         | world will include D
3 | th settles; k retries: new pass, pin p2>r_D | eval re-reads a: fold =
  |   | (0 set 5)+1 = 6 (D visible via retired clause). Reaches position 0:
  |   | fp(a, wk') = max(s2, bS≤s2, 0) = s2 == recorded s2 → prefix MATCHES
  |   | → returns cached th(1) — the fetch made when the world said a=1
4 | k commits | UI shows data fetched for a=1 beside sibling text rendering
  |           | a=6 → torn committed frame (the I20 failure the design
  |           | claims dead at C15 step 5 — that walk only varies same-slot
  |           | writes, never a cross-batch retirement between fetch & retry)
```

At best the reconcile backstop converts this into an urgent re-suspend
(fallback flash) if the committed NEWEST eval's suspension sentinel
miscompares against `lastRendered`; the walked I20 guarantee
("invalidate on included write that touched the prefix" — retirement made
D's write included and it touched the prefix) is broken either way.

**Severity: BLOCKER.** Wrong observable in two required cases (C16's
"after D commits, the effect re-runs seeing it"; C15/I20 stale-world
replay). **Judgment: local fix** — the architecture survives; the repair is
a cell fix inside the I16 discipline the design itself built: mint a
per-atom visibility stamp (`atom.visStamp = ++globalSeq`) at every
retirement that stamps/folds the atom's entries AND at every lock-in of a
slot holding entries for the atom, and include it in `fp`. This
over-invalidates cross-world checks (one spurious effect re-fold / one
refetch per touching commit — safe direction; a two-stage fp-miss →
fold-and-value-compare keeps effects quiet, and §9.2's R9 fallback already
concedes coarser-but-sound). Alternatively snapshot/prefix validation can
compare fold VALUES (the watcher comparator's discipline, §8.2 last line,
extended). Re-walk C15 step 5, C16-B1, and add a cross-batch
out-of-order-retirement row to the fingerprint-vs-oracle differential.

---

## F2 — HIGH (local fix): fn identity swaps are unstaged render-phase
## mutations; a discarded pass leaves the uncommitted evaluator installed,
## and committed-world evaluations run it

**Mechanisms defeated:** §11.1 `useComputed` fn/fnStamp swap × C14
render-purity × §11.4 committed-world effect evaluation. §11.1 mints
`fnStamp = ++globalSeq` on deps-identity change — necessarily at RENDER
time (the pass's own render must evaluate the new closure) — on the shared
live node. The C14 walk's discarded-pass leftover list (staged nodes,
add-only K1 edges, NM bits) omits fn swaps; §8.1's S3 clear column ("die
with the node") has no discard row. S15's staging protocol covers node
IDENTITY, not evaluator identity on existing nodes.

**Schedule:**

```
setup | committed: a=1; hook H: c = useComputed(() => a.state>0 ? x : y,
      | [x,y]) with committed x=5,y=6 → fn=f1, committed c=5; watcher W on c;
      | useSignalEffect E deps on c (snapshot fnStamp = f1's)
1 | transition k renders H with new prop x=50 | deps identity changed →
  | fn := f2 (closes over 50), fnStamp := ++globalSeq — on the live node,
  | mid-render, uncommitted
2 | k's pass is DISCARDED (superseded/interrupted; k later abandons)
3 | unrelated batch j retires → §11.4 trigger 2 flush | E's snapshot:
  | r.fnStamp ≠ node.fnStamp → invalid (the S3 conjunct itself forces the
  | recompute) → M(c, committed-for-root) evaluates with the node's CURRENT
  | fn = f2 → a=1>0 → 50
outcome | E observes c=50 — a value no committed tree ever rendered and no
        | world ever committed (committed props say x=5). C16 violated
        | ("effects observe committed state only"); C14 violated ("no graph
        | mutation observable across a discarded pass"). Watchers self-heal
        | (their next render re-installs f1 and re-mints), and the reconcile
        | backstop's spurious corrective re-renders H at 5 — but the effect
        | has no corrective: the wrong observation already escaped (network
        | call / imperative DOM / analytics fired on 50).
```

The dual resolution is also broken: if the swap were commit-gated instead,
the minting pass's own render evaluates the OLD fn and renders wrong output
for its world. Neither timing works without staging.

**Severity: HIGH** (wrong observable through the effect surface; silent).
**Judgment: local fix** — mirror §15.6: stage fn swaps per pass
(pass-local pendingFn/pendingStamp consulted by that pass's evaluations;
promote to the node at the commit effect; discard drops them; StrictMode
replay re-mints idempotently by deps-identity compare against the staged
value). Adds one row to the S3 cell and re-walks C1-T9/C14; no mechanism
moves.

---

## F3 — MEDIUM (local): RENDER_NEWEST has no stated demotion edge; a
## yield-gap write lets one pass observably read two worlds, and the
## repair burden falls silently on three other mechanisms

§6.1 classifies a pass RENDER_NEWEST when "selection equals newest" but
states no re-check when a yield-gap write (C7) falsifies the equality
mid-pass. A still-RENDER_NEWEST resumed pass routes reads to `k0.pull` =
drifted newest — the background's hard rule ("a pass's world must not
drift while it is paused") is violated at the read level.

**Schedule:** transition k (React-state-only, no signal writes → selection
= newest → RENDER_NEWEST) renders half its tree; component X (a FRESH
mount in this pass, unregistered) reads a=0 via K0; pass yields; a click
writes `a=1` (token C) whose walk finds no registered watcher inside the
pass's tree-half... pass resumes still RENDER_NEWEST; fresh mount Y reads
a=1 via K0; pass completes → X rendered 0, Y rendered 1 in one commit. In
every variant I constructed the tear is then caught pre-paint — registered
watchers force a restart via delivery; fresh mounts are snapped to the
committed world by the I18 fixup compare (both X and Y correct to 0);
post-retirement the backstop lifts both to 1 — so I could NOT produce an
escaped torn paint. But this coverage is accidental: no walk in the design
exercises write-during-RENDER_NEWEST-pass, and the fixup/backstop become
load-bearing for a drift the routing layer created. **Ask:** state the
demotion rule (the logged write path demotes live RENDER_NEWEST pass
bindings to real worlds — one bit, write-path-cheap) or add the
drift-and-correct walk with the fixup explicitly owning it.

---

## F4 — MEDIUM (local): world evaluations outside passes are claimed
## write-rejecting, but the written guard doesn't cover them

§5.1's guard is `currentPassBinding` then `foldFrame`. Effect-flush
evaluations (§11.4), fixup evaluations (§11.2 "memoized world eval,
write-rejecting"), and reconcile folds run OUTSIDE any pass binding, in
committed-for-root worlds. R8 makes writes-inside-computeds core-legal
(acyclic, NEWEST); §8.1's closure argument leans on "render writes throw."

**Schedule:** core-legal computed `c` whose fn writes atom z (R8, acyclic,
fine under DIRECT and LOGGED NEWEST); a mounted `useSignalEffect` depends
on c; any retirement triggers the flush; the world eval of c runs the fn;
the write guard sees no pass binding and no fold frame → the write
PROCEEDS mid-world-eval: tape append + a full notifyWalk re-enter the
engine inside an evaluation frame, and M(c, committed) caches an outcome
whose evaluation had side effects — the purity premise under §8.1's
closure argument and §9.2's prefix determinism is broken by a legal
program, with walk re-entrancy corrupting dep recording as the crash
vector. **Fix:** the world-eval frame joins the guard's first line (throw,
same message class as render-write rejection), matching the contract the
design already states in prose at §11.2/R8.

---

## Notes (no schedule survives to a wrong observable, or benign-but-unpinned)

- **N1.** Fixup soundness at a deferred mount's OWN commit requires
  lock-in (F3) to fire before that commit's layout effects — otherwise the
  committed compare sees a world excluding k and issues a false corrective
  (benign: the sync re-render lands after lock-in and renders the same
  value — one wasted render, by my walk). C11 asserts lock-in-before-
  effect-flush and fork tests 3/15 pin orderings, but no walk exercises
  mount-inside-k's-own-commit. Add it to the fixup window battery.
- **N2.** §9.3 step 3 "re-deliver: watchers ... get their per-(watcher,
  slot) bits re-checked" — "re-checked" is an operation defined nowhere
  (bits are set/tested/cleared/re-armed). React's ping + the belt conjunct
  cover every observer in the C15 walks; either name the observer this
  step exists for or delete it.
- **N3.** Cycle handling (R7) is stated for K0 (donor) and terminates for
  raiseFlag/notifyWalk via monotone-F/ticket, but ladder recomputation
  recursing through K0∪K1 world evals has no stated active-mark; a signal
  cycle first exercised inside a world eval needs the same detection the
  donor has for NEWEST.

---

## Verified held (attacked; failed to break)

1. **Invariant F path-transitivity (§6.4).** Attacked with: lazy first
   evaluations acquiring flagged deps (S9's twin), fnStamp-bump re-tracks
   under equality cutoff (C1-T9), mid-eval flag rises (monotonicity +
   afterRetrack's end-of-eval check), E-PRESERVE mirrors, discarded-pass
   K1 edges into staged nodes, quiescent kernel-stale nodes. The three
   site classes + per-episode monotonicity closed every interleaving; the
   induction's four event kinds are exhaustive over the stated mutators.
2. **Invariant R (F=0 ∧ CT serve).** I4 first-divergence + nonempty-tape ⇒
   walked-flag + the ¬CT conjunct: no schedule I built serves a divergent
   value (the C1-T8/T9 counter-schedules both hit the repaired routing).
3. **I18 mount fixup.** Retire-inside-the-window (C10-R), layout-effect
   writes by earlier siblings in the same commit (backstop at retirement
   covers the just-registered watcher pre-paint), joint multi-batch mounts
   (no equality filter on the token loop — I13 respected), fresh mounts
   rendered AHEAD of committed (compare snaps them back pre-paint,
   restoring frame consistency): all corrected pre-paint in my walks.
4. **B1 as stated (§8.3/§8.4).** Compaction can no longer regress a
   fingerprint; baseSeq's monotone-max is airtight for the
   representation-change case. (F1 is the adjacent non-injectivity hole,
   a different arithmetic fact.)
5. **I19 mask lifecycle (§5.3.5/§15.2).** The TKC-6 stale-bit tear is
   unrepresentable given clear-before-release + the unswept gate; C2's
   "no stale bit smuggles D in" holds; blocked-compaction slot retention
   (C3) interacts correctly with release-at-unswept=0.
6. **K1 tag wrap-clear (§7.2/§15.5).** Bulk clear at the mod-2^16 boundary
   makes stale false-matches impossible; the corrected MISSED-notification
   classification is right and the 2-bit forced test pins it.
7. **Token allocator (§15.4).** Live-skip bounded by the ≤31 invariant;
   dead-serial reuse safe under the swept no-retention rule (dev-asserted).
8. **globalSeq renumber + horizon (§15.3).** The retainer audit closes
   (tapes/memos/pins/lineages structurally dead at quiescence; surviving
   columns rewritten; JS-side snapshots epoch-fail-closed); the hard throw
   is named and forced-tested.
9. **Battery walks C2, C3, C4, C5, C6, C7, C8, C11, C12 (incl. O14
   ambient post-await classification — matches React 19's documented
   behavior), C13, C17-deletion:** re-executed; each holds, including
   C7's pin-gated-compaction ⇒ fingerprint-stability argument for LIVE
   pins (F1 arises only when no live pin protects the window) and C3's
   blocked-compaction ordering.
10. **Scar sweep S1–S15:** no scar repeated. Notably S13 avoided (one
    world per pass; no per-(world,batch) retention family) and S15
    answered by the staging protocol with the deferred-free-after-K1-reset
    ordering making dangling shadow links structurally impossible.
11. **No unaccompanied by-construction claims found**: §6.4 (induction),
    C6 (no-drain construction), §8.3 (mint monotonicity), §15.4
    (allocator), §15.6 (reclaim ordering) all carry their constructions.

---

## Verdict

The two-kernel architecture, tape/fold math, routing invariants, walk, and
lifecycle tables all survived direct attack, and the round's headline
repairs (raiseFlag, committed-compare fixup, mask lifecycle, tag
wrap-clear, staging) held under the schedules that killed their round-1
ancestors — but the I16 centerpiece still has one blocker-grade arithmetic
hole (F1: the fingerprint is not injective over visibility flips, breaking
effect snapshots and thenable prefixes across worlds) plus one high
lifecycle omission (F2: unstaged fn swaps leak discarded evaluators into
committed-world evaluations). Both repairs are cell-level fixes inside the
design's own change-source table discipline — a visibility stamp term and
a staged-fn row — with clear homes, bounded over-invalidation costs, and
no load-bearing mechanism displaced. **Verdict: repairable** — not
implementation-ready until F1/F2 are specced and re-walked (C15 step 5,
C16-B1 cross-batch variant, C1-T9/C14 discard variant), and F3/F4 get
their one-line rules.
