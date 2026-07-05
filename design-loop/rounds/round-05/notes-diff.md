# Round 5 proposed notes diff

Every line carries its evidence class: [BOTH] = both reviewers independently,
[WALK …] = walked schedule (linked artifact/section), [MEASURE] = none this
round. Monitor applies or rejects per line.

## INVARIANTS.md — proposed additions

- **I53 (extends I45; reopens nothing — completes it). Evaluator-version
  visibility must ride the full three-clause receipt rule, never chronology
  alone.** `promotedAtSeq ≤ pin` treats every promotion as
  instantly-globally-retired; a spanning transition's promotion then leaks
  into a T-excluding pass on a lagging root (pin > q, T ∉ mask ∪ lockView) —
  one committed root frame holds two evaluator versions, and the fixup agrees
  with the wrong value because committed-for-root also resolved "at now".
  Version entries must carry their promoting token and resolve
  retired/mask/lock exactly as receipts do; retention = tape compaction
  keyed on the token's retiredSeq. [WALK review-surgical-b-codex 1,
  re-derived by synthesis against BOTH round-5 designs and the round-4
  champion — synthesis C11-E kill + repaired walk]
- **I54. Any own-commit-value-neutrality argument for a mount-fixup fast-out
  holds only for watchers rendered BY the committing pass; deferred-effect
  mounts (Offscreen/Activity reveal) must reach the committed compare.** A
  quiet app gives `baseline.cas ≤ pin` while the commit's own fold of a
  token outside w_r.mask moves truth post-capture, invisible to every
  cas/lockView/wc conjunct → permanent torn committed DOM. The population
  premise must be an explicit conjunct (generation-checked pass id).
  [BOTH review-surgical-a-claude F1 ≡ review-surgical-a-codex 1 (two
  independent schedules: K3, Offscreen variant); repaired construction
  synthesis RS3, re-walked]
- **I55. A pass-visible stage whose owner hook never publishes (error
  abandonment, discarded alternate) needs a commit-time reconcile: flag the
  commit, walk the stage's cone filtered to this pass's rendered watchers
  with urgent pre-paint delivery, and write the lineage cache through.**
  Otherwise outside-boundary consumers commit never-promoted evaluator
  output with no receipt, no touched bit, no drain membership, and no fixup
  (already-subscribed watchers) — torn indefinitely. Mounting watchers need
  the commit flag as a fast-out conjunct (P4′ runs before layout
  subscription). [WALK synthesis C1-X7(a)/(b); the (b) variant is
  review-surgical-b-claude verified-held 4's schedule, filed by neither
  review as a finding]
- **I56 (extends I8/I49). A shared-counter horizon protocol must check at
  atomic-extent ENTRY with a documented, runtime-computable per-extent mint
  reserve; "renumber at the crossing mint's next boundary" is unsound
  because one synchronous extent (a commit's F9 publications + fold stamps)
  mints unboundedly many seqs.** Reserve bound = f(staged hooks, touched
  atoms of retiring tokens, roots) — quantities the registry already holds;
  crossing anyway must be a loud invariant throw kept dead by the sizing
  rule. [WALK review-surgical-a-codex 2; repaired construction synthesis
  RS5 with forced-tiny-H tests]
- **I57 (instance of I19). Cross-mechanism "counts as an entry of slot s"
  bookkeeping must be a real entry carrying never-reused token identity,
  with an idempotent swept mark at force-clear; reclamation by the
  compaction rule, never by decrementing a possibly-recycled slot
  incarnation's count.** The abstract relation under forced saturation +
  slot reuse either under-counts (bits clear early → flushSync-class tear)
  or leaks slots. [WALK review-surgical-a-codex 4; dissolved structurally
  by I53's token'd entries — synthesis RS1]

## DECISIONS.md — proposed additions/amendments

- **D12 amendment (champion pointer).** Round-5 champion:
  `rounds/round-05/synthesis.md`, normative composition = that file ←
  `rounds/round-04/synthesis.md` ← `rounds/round-04/design-consolidate-a.md`.
  Architecture class D8 unchanged; repairs RS1–RS7 over surgical-a's Δ set.
  Proof: adjudication Part I — every confirmed finding carries an
  in-architecture repair; the round's one champion-level defect (I53) is
  repaired with receipt machinery, no new mechanism; mechanisms 9.
- **D22 (new). The mount-fixup committed-side fast-out is the commit-entry
  baseline comparator with five conjuncts (population gate, cas ≤ pin,
  lockViewId equality, included-slot clocks, no abandoned stages) — the
  deletion alternative is rejected.** Deletion re-opens round-4's CONFIRMED
  row 16 cost (a w_fx eval per in-window mount in exactly P1's measured
  window, "no fallback authorized"), and its safety argument leaned on
  basis state that nothing constructs (S41). Proof: synthesis RS3
  construction + C9′(a) zero-eval pinned cost row + K2a/K2b/K3/C10(i)
  re-walks. [surgical-b's S5-R12-A and error-abandoned-mount schedules kept
  as pinned tests of the surviving comparator]
- **D23 (new). Evaluator versions are token'd tape-class entries on the
  hook's register: F9 samples F1.currentBatchToken() (fork test 35), the
  entry rides the seed visibility rule, joins slot(t)'s unswept gate, and
  compacts on universal visibility (t retired ∧ min live pins ≥
  retiredSeq(t)).** Promotion marking condition: raced open pin (excluding
  the committing frame), else defer to the commit's own retirement edge —
  non-instant-retire promotions mark at commit end. Settles I53's mechanism.
  Proof: synthesis RS1/RS2 constructions; C11-E + C1-X6 re-walks; quiet
  single-root promotions provably zero-cost (finding-3 branch repaired).

## OPEN.md — proposed changes

- **Round-5 outcome (append).** NOT dry. 15 findings adjudicated: 13
  CONFIRMED (one cross-design champion-level: I53; one both-reviewer: I54;
  one synthesis-found: I55), 2 REFUTED (both the artifact-boundary process
  complaints — the champion legitimately crosses rounds per LOOP.md/D12),
  0 needs-measurement. Round-4 docket repairs R1-core/R2/R3/R4/R8/R9 all
  HELD under adversarial re-derivation in both designs; the judge's two
  round-4 blockers are repaired (Q1 held under both reviews; Q2 needed the
  I54 population gate). **Budget cap reached (5 rounds): the exit case
  presents `rounds/round-05/synthesis.md` as best-so-far** pending the
  round-5 judge's re-walk; exit criterion 2 (two consecutive dry rounds) is
  NOT met — the human decides between accepting best-so-far or funding a
  round 6 whose docket would be: judge-confirmed residue of RS1–RS7 only.
- **O26 (new).** Exit documentation task: mechanically merge the three-file
  normative composition into one implementation spec (no design content —
  concatenation + cross-reference resolution). Both codex reviewers
  independently flagged the diff-chain's auditability tax; the round-4
  judge's explainability deduction said the same.
- **O23 (amend).** Fork existence proofs now also cover tests 34
  (commit-entry capture ordering), 35 (F9-context token sampling — now
  load-bearing for D23 version attribution, not just slot sourcing), 36
  (synchronous discardAllWip) on the O7 critical path.
- **O12/SPK-R (amend row).** Promotion rows re-keyed to P2″'s condition
  (marks fire on raced-pin OR non-instant-retire promotions); add
  version-visibility resolution compares and the C11-E lock-in
  late-subscriber reconcile row.
- **SPK-W (amend row).** Ladder-step-3 over-invalidation: mask∋s memos
  re-derived once per raced promotion.
- **G-F (amend row).** One w_fx eval per reveal-shaped mount (K3
  population) and per abandoned-stage commit mount (C1-X7(b), rare);
  in-pass mounts stay zero-eval (pinned cost test C9′(a)).

## SCARS.md — proposed additions

- **S40. Chronology-only (pin-only) evaluator-version visibility.** Killing
  schedule: spanning transition T stages e1 on root A; A commits (F9 at q);
  P3′ schedules root B's watcher in T's lanes so T keeps living; urgent U on
  B (pin p2 > q, mask {U}, lockView(B) ∌ T) mounts W_new → effStamp selects
  e1 because q ≤ p2 → U commits W_new=e1-output beside W_old=e0-DOM — torn
  root-B frame until B's deferred T render (unbounded if e1 suspends on B).
  Why not local: fixup/reconcile agree with the wrong value because
  committed-for-root also resolves "at now"; the repair is the visibility
  RULE (token'd entries, I53/D23), not a downstream check. (b-codex 1;
  synthesis C11-E.)
- **S41. Exact-basis (vector-compare) fast-path gating over K0-served
  values without a constructed, priced K0-side basis.** Killing schedule
  (surgical-b as written): quiet mount serves K0 under committed r0 (no
  world memo exists — nothing retains the rendered basis); cross-root F9
  promotes r1; a NEWEST read refreshes K0 and its basis to r1; layout fixup
  reads B0-now = r1, matches committedForRoot-now = r1 → returns → W's
  committed DOM shows r0-output indefinitely. The conservative horn
  (unverifiable ⇒ always-fold) re-prices every quiet mount against P1 with
  no authorized fallback. Deeper rule: routing conjuncts must be O(1)
  resident words maintained by existing walks (marks/clocks), never vector
  compares against state no mechanism maintains — the recording half would
  land O(D) merges on the donor kernel's recompute epilogue, the measured
  "invades every hot walk" class. (b-claude F1 + F3/F4; rejected in
  synthesis Part II.)
- **S42 (extends S33's family). Own-commit-neutral fixup fast-outs without
  a population gate.** Killing schedule: Activity pre-renders hidden W in
  deferred pass P_h (pin p1, mask ∅, effects deferred); one event writes
  a@s2>p1 and reveals; u's render bails on the pre-rendered W; u's commit
  captures baseline at entry (cas = init), folds u (cas moves
  post-capture); W's layout fixup: loop sees only live tokens (u retired),
  baseline.cas ≤ p1 ∧ lockView equal ∧ mask-∅ clocks vacuous → return → V
  paints f(1) beside W's f(0), no future flip enumerates W. The
  value-neutrality proof quantified over committing-pass watchers only;
  the premise must be conjunct 0, not prose. (a-claude F1 ≡ a-codex 1;
  synthesis RS3/K3.)
- **S43. Asynchronous forced-discard (interleaved-update insertion) as the
  renumber precondition, and fixed "one extent" slack at the crossing
  mint.** Killing schedules: (a) insertion defers each root's abandonment
  to its next scheduler slice; dense mint traffic crosses H with a live
  yielded pin → post-wrap retiredSeq stamps below the pin → S38(a)
  re-entered through the gap between the two readings of "discard";
  (b) a single synchronous commit publishes S+1 hooks past any fixed
  reserve → promotion q ≤ live pin p → P2″'s raced-pin test inverts →
  unrouted version → torn resumed frame. Rules: discard is a synchronous
  fork capability (F2 discardAllWip, test 36); horizon checks run at
  extent ENTRY with a computed reserve (I56). (a-claude F3 + a-codex 2;
  synthesis RS5/RS6.)
