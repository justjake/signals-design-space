# Round 3 proposed notes diff

Evidence classes used: [WALK <artifact> <finding>] = a schedule re-derived
in this round's synthesis adjudication; [BOTH …] = independently found by
two models; [MEASURE …] = a measurement artifact; [REFUTED-WALK] = the
corrected walk recorded so the point is not re-raised. Monitor applies or
rejects per line.

## INVARIANTS.md — proposed additions (Round 3)

- **I31. Evaluator identity is a fourth world-divergence source with no
  receipt; every routing/validity surface needs an evaluator conjunct.**
  A pass holding a staged evaluator diverges from K0's cache with zero
  receipts: fast-path routing needs a staged-probe conjunct, RENDER_NEWEST
  must demote on staging (not only on writes), memo validity must compare
  a flattened evaluator-stamp vector BEFORE any clock-based serve (nested
  evaluators included), and promotion must dirty the K0 node or the
  pre-promotion cache serves forever. [BOTH exit-claude F1 ≡ exit-codex 5;
  ladder half exit-codex 6; repaired construction synthesis §6.2′/§8′,
  re-walked T11′]
- **I32. K1 is a union across worlds; unions of per-world-acyclic graphs
  cycle. Every value-blind full walk needs per-walk visited state.**
  Monotone-frontier recursions (edge-add `newBits & ~touched`)
  self-terminate; value-blind notification/retirement walks do not — a
  two-flag program (`c = flag ? d : a`, `d = flag ? b : c`) hangs the
  write path. Per-walk generation stamp; cost priced in G-N/G-W; wrap
  lifecycle row required. [BOTH exit-claude F3 ≡ exit-codex 7; synthesis
  T12]
- **I33. Untracked reads license temporal staleness, never world leakage.**
  A K0 cache produced by an evaluation whose untracked read hit a
  receipted atom embeds possibly-pending state; serving it to any
  non-newest world leaks an excluded write (no edge exists to route, and
  recording one would violate untracked semantics). Node-grain taint
  (recomputed per NEWEST evaluation: untracked read hit non-empty tape)
  as a routing conjunct; world evaluations fold untracked reads in-world,
  edge-free. [WALK exit-codex 4; synthesis T13]
- **I34 (extends I21/I14). Every visibility-flip SOURCE needs both a stamp
  minted at every occurrence AND a durable (re-enumerable) flush path.**
  Watermark ADVANCES are flips (they admit entries below an
  already-visible max); consumable write-time queue entries get eaten by
  earlier unrelated flushes. Retirement → per-atom retireVisStamp;
  lock-in AND every advance → per-(root, slot) lockStamp captured in an
  immutable re-minted lock view whose id is part of committed-for-root
  worldKeys; retirement/lock-in flushes enumerate via touchedList, never
  only the queue. Root-scoping the lock term is load-bearing: a global
  lock-side stamp lets root A starve root B. [WALK exit-claude F2 +
  breaker-claude F3 (same family, two designs); root-scoping
  breaker §2.1-B1, held by both its reviewers; synthesis C11-A]
- **I35. Side-effect-bearing caches must value-revalidate before
  re-fetching.** Stamps legitimately over-invalidate (I21); a suspense
  capsule that refetches on every stamp move re-fetches settled resources
  on content-neutral flips (lock→retired handover; equal-value churn) —
  duplicate side effects and starvation under same-atom traffic. On fp
  mismatch: re-fold in this world, equality-stable compare, re-stamp in
  place when equal, refetch only on real change. Validity-by-value is
  legal where delivery-by-value is not (D13 governs delivery only).
  [WALK breaker-codex 4 + breaker-claude F7 (severity resolved by walk);
  synthesis C15-5″]
- **I36. Carrier capture must be registration-time for host-scheduled
  callbacks (AsyncContext parity); invocation-time capture alone strands
  every async callback scheduled inside an action.** The twin-build
  transform captures at generator instantiation; an async function handed
  to setTimeout inside an action instantiates on a bare stack and captures
  null → its writes commit before the action settles. Armed-gated
  registration shims on enumerated schedulers (timeout/interval/microtask/
  rAF/message) close the class; unshimmed registrars are documented
  boundary. Not an S22 repeat: shims cover explicit registration only —
  awaits still ride the transform. Verified against SP-F8: its "timers"
  row tested plain callbacks resolving awaited promises, not async-fn
  callbacks. [WALK exit-codex 1 + MEASURE spf8 artifact re-read;
  synthesis C12-T]
- **I37. A carrier token consulted after its retirement must degrade to
  ambient classification (+ dev warn), uniformly across rungs.** A
  fire-and-forget child continuation can outlive its action; rejecting
  crashes, re-interning creates never-retired receipts, recycling
  contaminates. Ambient fallback is React parity (a late un-awaited
  child's setState lands in its own batch). Per-resource park refcounts
  are NOT admissible: AsyncContext has no resource-creation hook (rung
  asymmetry) and a leaked never-settling child parks a lane forever.
  [WALK exit-codex 3; synthesis C12-F]
- **I38 (refines I7 and D16). Fold-op meaning is world-scoped once
  evaluators can stage.** (a) The empty-history equality drop is legal
  only for ops with world-invariant meaning — plain `set` always;
  updater/reducer only under immutable evaluators; stageable ReducerAtoms
  always append (a dropped "no-op" action replays differently under the
  staged reducer). (b) Reducer promotion with pending receipts must
  re-fold NEWEST under the new committed reducer and notify; (c) within a
  commit, evaluator/reducer publication precedes the retirement folds due
  at that commit, or the fold compacts under the stale reducer while the
  committed tree rendered the new one. [WALK breaker-codex 1 + 2
  (cross-design — exit candidate had the same text); synthesis C3-R]
- **I39. Slot bookkeeping must outlive every pass whose pin excludes the
  slot's entries, and slot demand must be bounded anyway.** Clearing
  touched columns at retirement while a pinned pass lives serves K0 to a
  world that excludes the retired write (torn frame); retaining them
  makes live-plus-retiring slots exceed 31 under an input storm during
  one yielded transition. Retain via the unswept gate (I10) AND define
  saturation: force-clear the oldest fully-retired slot and flip affected
  pinned passes to world-path-only (per-pass flag), with a forced test.
  [WALK breaker-claude F1 (both horns) + F5; synthesis T14]
- **I40. Evaluator stamps inside retry-crossing identity keys must be
  lineage-stable for equal dep values.** A Suspense retry is a new pass;
  per-pass fresh stamps make capsule prefixes mismatch every retry →
  refetch-forever livelock with duplicate side-effectful fetches (the
  S20-adjacent world-instance-identity class). Stage per pass for I22;
  mint per (lineage, hook, deps-values). [WALK breaker-claude F2
  (cross-design — exit candidate §11.1/§9.2 identical); synthesis
  C15-4′/C14]
- **I41. The evaluator promotion edge is "hook becomes current" (fork
  fact), not effect execution.** Hidden Offscreen commits promote with no
  effect firing; error-abandoned subtrees and stale alternates never do
  (generation CAS); publication must precede the same commit's retirement
  folds (I38c) and layout effects. [breaker §2.1-B2 construction, held by
  BOTH breaker reviewers; ordering hole breaker-codex 1-B; synthesis
  §11.1′/F9]
- **I42. Refresh-exemption carry must be the full reverse-reachable K1
  cone.** Reach is path-transitive; carrying only direct in-edges strands
  upstream links (`x→u` of `x→u→w`) and the next episode's write tears.
  Two-strike rank Σ(2−strikes) proves termination for a fixed observed
  set. [breaker §2.1-B3 + termination held by breaker-claude; the
  exit-candidate's in-edge carry killed by the same schedule; synthesis
  T8-N′]
- **I43. Mount-fixup corrective skipping is inclusion+clock, never
  equality.** Skip token t iff slot(t) ∈ the mount's rendered
  mask∪lockView AND wc[slot(t)] ≤ the rendered pass pin — a fully
  included token cannot diverge for that watcher, and a post-pin write
  fails the clock. Unconditional correctives double-render every mount
  inside a live batch's own pass (C9); equality-filtered skipping is S10.
  [WALK breaker-codex 6 (cross-design — exit-candidate C9(a) hand-waved
  "React bails"); synthesis C9′]

## DECISIONS.md — proposed changes (Round 3)

- **D12 amendment (champion pointer).** Round-3 champion:
  `rounds/round-03/synthesis.md` — architecture class D8 unchanged;
  repairs R1–R17; breaker transplants adopted WITH invariants: F9
  hook-publication (I41), immutable per-root lock views (I34), full-cone
  refresh carry (I42), corrected split G-R comparator (breaker B4),
  ActionScope + realm affinity, breaker W1/W2/W3/W5 spike workloads.
  Proof: adjudication table Part I — every confirmed finding carries an
  in-architecture repair endorsed-shaped by its own reviewer's judgment;
  no confirmed finding invalidates K0/K1/tape/visibility/seam.
- **D16 amendment (reducer identity).** "Dev-warn on swap with pending
  receipts" is insufficient alone; the settled semantics are I38's:
  promotion-visible folds (re-fold NEWEST at promotion; publication before
  same-commit folds), always-append for stageable reducer atoms, and the
  differential battery extended to swap-with-pending rows. Proof:
  [WALK breaker-codex 1/2], synthesis C3-R.
- **D17 (new). F8's boundary contract is settled and closed against
  re-litigation absent new evidence:** at carrier rung 2, raw post-await
  signal writes in uncompiled code misattribute to their ambient batch —
  sound, bounded, dev-warned, boot-tested per I30/O20/D15; this is a
  declared build-prerequisite support boundary, not a preamble
  runtime-restriction move, so "no reliable rejection ⇒ blocker" does not
  apply. The supported escape hatch for opaque boundaries is explicit
  ActionScope.set/dispatch; scheduler shims (I36) shrink the in-app
  class; rung 1 erases it. Proof: [REFUTED-WALK exit-codex 2 ≡
  breaker-codex 5 — both re-raised I30's own recorded schedule with no
  new evidence; synthesis Part I #10].
- **D18 (new). useSignalEffect evaluator identity rides React's native
  deps re-fire; no staging/F9 path for effects.** A deps change re-runs
  the effect at its own commit, which re-tracks and re-subscribes;
  routing effect fn changes through staged publication leaves the new
  dependency edge-less forever. Proof: [WALK breaker-codex 3], synthesis
  C16-D.

## OPEN.md — proposed changes (Round 3)

- **Round-3 outcome line (replaces the round-3 docket paragraph).** The
  dry-check FAILED its premise: 28 findings adjudicated, 25 CONFIRMED
  (several cross-design: BC-F2, BCX-1/2/6, BC-F1's saturation horn applied
  to the champion text), 3 REFUTED, 0 needs-measurement. Exit criteria NOT
  met. Champion updated to the round-3 synthesis (D12 amendment).
- **Round-4 docket.** Adversarial re-review of the round-3 NEW math, each
  with its walk to attack: taint routing conjunct (I33; attack: taint
  set/clear races across yield gaps, DIRECT→LOGGED transition caches),
  walkGen termination (I32; attack: reentrant walks from edge-add
  deliveries inside a walk), immutable lock views + lockTerm fp (I34;
  attack: view re-mint vs yielded same-root passes, fp cost),
  lineage-stable stamps (I40; attack: deps oscillation within one lineage,
  cross-lineage stamp reuse), value-revalidated prefixes (I35; attack:
  revalidation reading through staged evaluators; fold cost on deep
  prefixes), F9 ordering + reducer re-fold (I38/I41; attack: multi-root
  commits with pending receipts on both, promotion during saturation),
  scheduler shims + retired-token fallback (I36/I37; attack: shim
  liveness races, nested registrations, MessageChannel), saturation
  spillover (I39; attack: force-clear during an open walk; fastPath flag
  vs RENDER_NEWEST). Also re-verify the three normative readings from
  notes N1–N4 landed as text.
- **O19** — unchanged (SPK-L pending); synthesis now cites [SPKHQ→O19]
  wherever the 2.4–3.8% floor appears (kills the breaker-claude F6
  provenance ambiguity — REFUTED, provenance is this line).
- **O21** — extended: SPK-G8 additionally measures I35's re-fold
  revalidation cost and the evaluator-stamp vector length (R2) alongside
  prefix length.
- **O22 (new).** Scheduler-shim coverage matrix: which registrars are
  shimmed per host, cost at registration while armed, and the dev-warn
  false-positive rate in busy apps (G-A matrix rows; correctness rows in
  fork/build test 25). Decision rule: any measurable unarmed cost ⇒ the
  shim install moves behind the carrier-armed path entirely.
- **O23 (new).** F9's fork-side existence proof joins O7's risk line: the
  hook-becomes-current publication edge (hidden Offscreen, error
  abandonment, alternates) has no current-generation React existence
  proof; fork tests 20–23 on the critical path with O7's 15–17.
- **Spike queue table updates.** SPK-N1 ← breaker W1 workload (+walkGen
  pricing); SPK-G8 ← breaker W3 + prefix/vector length + I35 re-fold;
  SPK-R ← breaker W5 A/B under the corrected split comparator (G-R-core
  vs DIRECT batch(); G-R-react vs useState) — the old render-relative
  gate is DELETED (zero-denominator defect, breaker B4); SPK-W adds the
  walkGen stamp; SP2 promoted from dev validator to CI fuzz gate
  (strong-reading E-PRESERVE, I-see BC-F4).

## SCARS.md — proposed additions (Round 3)

- **S23. Evaluator-blind fast paths ("worlds diverge only through
  receipts").** Killing schedule: React-state-only transition classified
  RENDER_NEWEST; useComputed stages f_B; both the staging component and a
  sibling are served f_A's K0 cache; the pass commits a wrong frame;
  promotion never dirties K0 → wrong NEWEST forever, no receipt, no
  backstop. Second horn: the validity ladder serving on slot clocks
  without comparing evaluator stamps replays a discarded closure's value
  inside its own pass. Why not local-as-written: routing, RENDER_NEWEST
  classification, memo validity, AND promotion all need the conjunct —
  one omission re-opens it. (exit-claude F1 + exit-codex 5/6; repaired
  R1/R2.)
- **S24. Per-pass-minted evaluator stamps inside retry-crossing identity
  keys.** Killing schedule: suspense retry = new pass → re-stage vs
  committed → fresh stamp → flattened prefix mismatch → drop settled
  thenable → refetch → suspend → repeat: transition never commits,
  duplicate fetch per retry. Rule: I40 lineage-stable minting.
  (breaker-claude F2; identical text in the exit candidate.)
- **S25. Invocation-time-only carrier capture.** Killing schedule:
  `startTransition(async () => { await new Promise(res => setTimeout(async
  () => { a.set(1); res() }, 0)); await gate })` — the timer invokes the
  transformed async callback on a bare stack; genBody captures null;
  the write lands in default D and commits before the action settles;
  the boot probe cannot see the composition. Rule: I36 registration-time
  capture for host schedulers; residual registrars documented.
  (exit-codex 1.)
- **S26. Consumable write-time queues as the only committed-observer
  trigger for lock-in/advance flips.** Killing schedule: E's queue entry
  consumed by an earlier unrelated retirement flush; the watermark
  advance that later exposes the parked write mints nothing the snapshot
  observes and re-enqueues nothing → effect stale until full retirement
  (unbounded, io-gated). Rule: I34 stamp-every-mint-site + durable
  touchedList enumeration. (exit-claude F2 + breaker-claude F3.)
- **S27. World-invariant-op assumption in write-time drops ("empty-tape
  equality drop is always safe").** Killing schedule: dispatch "tick"
  under committed r0 (identity) with empty tape → dropped; the transition
  stages r1 (s+1) → nothing to replay → ReducerAtom 0 vs useReducer 1.
  Rule: I38a. (breaker-codex 2.)
- **S28. Unordered/effect-grain evaluator publication around retirement
  folds.** Killing schedules: (a) hidden Offscreen commit never runs the
  hook effect → committed tree from f1, committed evaluator f0 —
  divergence with no write; (b) fold-before-publication compacts a
  pending reducer receipt under the stale reducer while the committed
  tree rendered the new one — permanent 10-vs-1 fork. Rule: I41 (F9
  hook-becomes-current edge, CAS, publication-before-folds).
  (breaker §2.1-B2 + breaker-codex 1-B.)
- **S29. Retirement-time touched-column clearing (and, dually, unbounded
  slot retention) around pinned passes.** Killing schedules: (a) clear at
  retire → resumed pin-p pass reads K0-clean computed 11 beside folded
  atom 0 — torn frame matching no world; (b) retain until pins release →
  one yielded transition + ~31 retiring input batches exhausts slot
  interning with no stated behavior. Rule: I39 (unswept retention + the
  saturation spillover). (breaker-claude F1/F5.)
- **S30. Direct-in-edge-only carry for refresh-exempt nodes.** Killing
  schedule: K1-only chain x→u→w, w exempt; carry {u→w}; reset; next
  episode's write to x reaches nothing → torn commit. Rule: I42 full
  reverse-reachable cone. (breaker §2.1-B3; exit-candidate §5.4 had the
  in-edge text.)
- **S31. Stamp-move ⇒ refetch for side-effect-bearing caches.** Killing
  schedule: lock→retired visibility handover on an already-visible entry
  (or equal-value urgent churn) moves fp with no content change; the
  capsule discards its settled thenable and re-runs the factory — repeated
  per touching retirement: duplicate fetches, transition starvation.
  Rule: I35 value-revalidation before refetch. (breaker-codex 4 +
  breaker-claude F7.)
