# SCARS — dead approaches, each recorded as the schedule that killed it

Format: the approach, the killing schedule, why the fix isn't local. Bare
prohibitions anchor; schedules teach. Curated by the monitor only.

- **S1. No-log urgent writes ("urgent goes straight to committed").**
  Killing schedule: C3 — deferred `+1` pending, urgent `×2` applied and
  discarded; fold replays `+1` over the new base → 3; React commits 4. Also
  unrepresentable: C2 (flushSync excluding an applied default batch). Why
  not local: retaining urgent ops IS always-logging; the "no side log"
  identity dies with it. (Candidate B's kill; extraction 2026-07-04.)
- **S2. Read-only canonical topology for all worlds + "marking through
  canonical topology never misses".** Killing schedule: C1 — k writes
  `flag` then `a`; the k-world cache of `c` (`SV_READY`-style) is served
  forever; no walk from `a` reaches `c`; watcher never notified in k's
  lane; torn commit corrected one frame late. Why not local: the design's
  own analysis concedes the repair is per-world dependency tracking, which
  its read-cheapness premise forbids. (Candidate C's kill; verified against
  C §10.4's induction — it covers only mark-then-read-once.)
- **S3. Canonical-only notify walks bolted onto an overlay ("the walk
  reaches everyone who matters").** Killing schedule: C1 again, in the
  synthesized winner: overlay evaluations are untracked, so the divergent
  dep has no edge; the always-walk of §9.8 walks the wrong graph. Why not
  local-as-claimed: the repair needs registries + full certificates + drain
  re-validation (a 4-mechanism compensation stack), or a structural
  mechanism (world edges / second kernel). (Review 2026-07-04T08-52 F2/F3.)
- **S4. Drop-on-abort retirement (committed=false discards writes).**
  Killing schedule: C12 — `startTransition(() => a.set(5))` with no
  subscriber → no React work → committed=false → write silently reverts.
  Local one-branch fix exists (fold instead), so the scar is the *policy*,
  not the machinery: persistence must never depend on subscription.
- **S5. Certificates that record only "atoms with concurrency state at
  evaluation time".** Killing schedule: C1's memo half — `a` is unlogged
  when world-k first reads it, acquires a tape on the later write, and no
  recorded source moves → stale cache validates; the spec's own T1
  justification contradicted its own definition. Rule: validity records
  must cover the COMPLETE read set (sentinel for no-state-yet), and nested
  evaluations must flatten/merge child certificates. (Review F3 + codex
  finding 2, mutually confirmed.)
- **S6. Concurrency machinery keyed to watcher count.** Killing schedule:
  `startTransition(() => { atom.set(1); setShow(true) })` mounting the
  FIRST watcher — the write predates LOGGED mode, no receipt exists, urgent
  renders leak the transition value. Rule: activation is monotonic on
  bridge registration. (Codex finding 3, independently verified.)
- **S7. Wall-clock-scoped render context ([passStart, passEnd] scalar).**
  Killing schedule: C7 — urgent write in a handler during a yielded
  transition render throws "write during render" / reads resolve against
  the pin. Rule: render-context truth is per-callstack; the fork must
  expose yield/resume. (Review F1; applies to every legacy candidate.)
- **S8. Equality-gating writes against the newest world.** Killing
  schedule: C8 — deferred T `set 1`, urgent U `set 1` dropped as equal;
  U's render excludes T and shows 0; truncation variants lose the write
  entirely. Rule: I7 (drop only on empty history; equality lives in
  fold/notify). (Codex finding 4 + review F5.)
