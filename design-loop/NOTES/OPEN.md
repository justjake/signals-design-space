# OPEN — live questions (stance sources for the next round)

Closed this round (resolution recorded in DECISIONS/INVARIANTS): O2 (I11),
O4 (S11 + the fork-native maximalist kill), O5 (edge events + one flag
read, unattacked), O6 (D10), O8 (D11), O9 (D9), O10 (coalescing declined by
all four designs — legality preconditions exceed the win; retirement
compaction covers growth).

- **O1 (narrowed).** Per-world dependency knowledge lives in K1 as real
  recorded edges (D8), pending continued judge scrutiny. The compensated
  single kernel remains the named fallback if K1 costs disqualify (the walk
  structure and delivery dedup survive that swap); revisit only on SPK-*
  gate failure.
- **O3.** SP2 unblocked (architecture picked): E-PRESERVE dev validator
  cost; >10% dev overhead → sampled validation.
- **O7 (narrowed).** Per-root lock-in table lives in the bindings' root
  registry (pass-world derivation, effect flush, fixup worlds consume it).
  REMAINING RISK: the fork-side per-root facts have no current-generation
  existence proof — fork tests 2/3/4 are on the critical path (synthesis
  gap G4).
- **O11.** Mount-fixup over-render under many live transitions: reach-based
  correctives cost ≤ live-deferred-count renders per flagged mount. Is that
  constant acceptable at 10k-mount scale, or does the fixup need a cheaper
  reach test (per-slot touched-cone bloom)? Measure in the
  react-concurrent-store harness before optimizing.
- **O12.** Value-blind delivery fan-out (adopted-by-choice in D8's walk):
  SPK-N1's grid decides whether `notifyCutoff:'evaluate'` ships default-on
  above a fan-out threshold. The round's single NEEDS-MEASUREMENT
  adjudication.
- **O13.** Counter horizons and allocators: state mid-episode behavior at
  globalSeq saturation (a named guard is required even if physically
  remote — forced-small test builds cannot exist without one), the
  token-serial live-skip allocator construction, and the K1 tag width +
  clear policy — tag-wrap is MISSED notification, not over-notification
  (refutes the champion §7.4's claim; three codex reviews converged here).
- **O14.** Async-action continuation identity: what does write
  classification answer during a post-await continuation? Parking is
  lifetime only; "one token across the await" is an unaccompanied
  assertion. Needs a fork async-scope fact + fork test (two concurrent
  parked actions, interleaved settlements, differential vs React 19).
- **O15.** Fold-callback purity: do `update(fn)`/reducer callbacks reading
  signals throw, read-untracked-at-fold-world, or record deps? Pick and
  enforce (React parity suggests: throw in dev).
- **O16.** Reducer identity in ReducerAtom folds: which reducer version
  replays queued actions after a rebase (React uses the rendered one)?
  Stage per lineage or document + differential-test.
- **O17.** Does the public computed API expose `previous` (donor does)? If
  yes it is a world-eval input that memo validity and rebase must cover;
  if no, say so and pin with a conformance note. Also pin sentinel
  settlement semantics at NEWEST and the RENDER_NEWEST↔world suspension
  boundary (one duplicate fetch, one identity flip max).

## Round-2 docket (confirmed blockers against the champion, all local)

1. **The I16 validity-source family (one redesign, three holes):** judge B1
   (fingerprint collapse at retirement compaction, C12/C16) + TKC-2
   (sentinel memos survive thenable settlement, C15) + TKC-8 (fnVersion
   absent from the validity predicate). Repair as a closed change-source
   enumeration with an auditable table.
2. **I17:** afterRetrack flag raise is node-local; equality cutoff strands
   CLEAN downstream nodes → invariant R serves divergent values (TKC-3B).
3. **I18:** mount fixup's live-token enumeration goes empty when a batch
   retires inside the mount window; advertised fallback unreachable (TKC-4).
4. **I19:** lockedIn masks never cleared at slot recycle → a root renders a
   new batch's uncommitted writes against its own DOM (TKC-6).
5. **I20:** lineage-keyed positional thenable cache survives intra-batch
   writes → retry renders stale-world data (CO-codex-4).
6. **O14:** async-action post-await attribution unconstructed (CO-codex-3).
7. **SPK-H remedy:** hooks must compile out of DIRECT mode (closure
   rebuild); design the LOGGED-mode hook story and queue its measurement.
8. **SPK-Q remedy:** the read-routing branch moves behind the LOGGED-mode
   closure rebuild.

Plus non-blocker round-2 work: K1 tag-wrap (O13), arena reclamation for
abandoned fresh nodes (S15), purity/reducer/previous pins (O15–O17).

## Spike queue

| id | question | method | decision rule | status |
| --- | --- | --- | --- | --- |
| SP1/SP1b | host tax | — | — | DONE (I11: boundary free; storage 5–12%) |
| SP1c | closed protocol + packed columns ≈ donor? | as specified | ≤2% ⇒ unblocks closed-kernel refactors | DEPRIORITIZED (no design depends on it) |
| SP2 | O3 validator cost | brute-force K1-edge cross-check, synthetic forked topologies | >10% dev overhead → sampled validation | unblocked, queued |
| SPK-H | K0 two-hook recompute tax | donor vs hooked; tier-0 + kairo | >1% → hooks compiled out of DIRECT; re-measure LOGGED | **DONE — RULE TRIGGERED** (deep 1.025–1.035 min across 3 sessions; `research/experiments/spkh-spkq-kernel-hook-tax.md`); LOGGED-mode tax measurement queued |
| SPK-W | logged-write price | set-heavy isolated writes | >2× DIRECT → inline-2 receipts / tape pooling | queued (needs overlay prototype) |
| SPK-N1 | O12 fan-out grid (suppressed-write × watchers 10/100/10k) | adversarial cone 1k, 100 writes/frame | >2× DIRECT propagate class or >1 spurious render/(watcher,batch) → per-slot-marks fallback or default-on evaluate-cutoff | queued (the O12 adjudication) |
| SPK-G8 | held-open read bursts (+ first-touch routing) | kairo-scale held transition, mixed read/write | fail → per-(atom, worldKey) fold cache | queued (needs overlay prototype) |
| SPK-Q | quiet-React read tax | donor + NEWEST branch, tier-0 | >2% → branch behind LOGGED closure rebuild only | **DONE — RULE TRIGGERED** (reads 1.024–1.038 min across 3 sessions, thin margin; idle-machine rerun is the cheap challenge) |
