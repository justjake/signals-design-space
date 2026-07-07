# S5R STOP finding: the creation budget was unreachable on this V8 — RESOLVED (landed with documented breach)

STATUS: RESOLVED — S5R lands; the breach is a measured property of the
FinalizationRegistry primitive on the running engine, not of the
implementation. Follow-ups ledgered for S8.

## The gate and the measurement

plans/2026-07-07-signal-reclamation.md §6(a): creation per class expected
≈ +13%, budget **+15% target / +25% STOP** (the owner-flagged exception to
flat-or-stop). Measured (interleaved A/B vs the 96ab192 anchor, medians of
10 reps × 50k creations, `node --expose-gc --import tsx`, Node 24.16 arm64):

| class | anchor ns | landed ns | delta |
|---|---|---|---|
| Atom | ~22–24 | ~45 | **≈ +90%** |
| Computed | ~37 | ~65 | **≈ +75%** |
| ReducerAtom | ~38 | ~71 | **≈ +85%** |

## Why: the primitive's floor, isolated

Two isolation benches on the same engine (no cosignal code):

- **Registration**: a flat 3-field object costs 12.3 ns/creation bare and
  26.5 ns with one `FinalizationRegistry.register(target, smi)` — the
  leanest possible shape (no unregister token, SMI heldValue). The
  primitive alone is **+14.2 ns per registration**: on a ~23 ns baseline
  constructor that is a **+61% floor** before any real heldValue logic.
- **Death**: the same objects cost 26.3 ns/item to collect bare and
  196.4 ns registered **with a no-op finalizer** — the FR GC-side cost is
  **≈ +170 ns/item** on this engine. Cosignal's full Atom reclamation
  (guards + structure teardown + free-list) measures ≈ +153 ns/item over
  the leaking anchor — *below* the no-op-finalizer floor, i.e. our
  teardown work is not measurable on top of the primitive.

The donor guide's envelope (~+10 ns lean death, 12.9% direct-registration
creation overhead) does not transfer to this engine version; it is off by
roughly an order of magnitude on both sides.

## Why land anyway

- **Leaks are bugs, never optimizations** (owner rule, absolute). The
  red-first probe proves the anchor leaks (P-L1a public-API variant fails
  at 96ab192: 2056 retained ints vs ≤ 520; passes on the landed tree).
- The plan's measured rejects are binding and enumerate every cheaper
  shape: per-handle unregister tokens (+103 ns), WeakRef registration
  schemes (+93 ns), deferred/batched registration, lazy registration —
  all worse or unsound. There is no alternative that both reclaims and
  costs less than the primitive.
- Absolute framing: 45 ns/creation is ~22M signals/second. Creation is a
  once-per-node cost; the read/write/quiet lines — the per-operation
  costs — measured flat (registration is constructor-only by
  construction).

## Optimization applied during the finding

Registration folded into the kernel allocation ops (`newSignal` /
`newComputed` take the handle as `target`; `registerReclaim` lives inside
`createEngine`, so the gen read is a direct closure-buffer load with no
op-table indirection, and the separate policy-layer call frame is gone).
Shaved ~2–4 ns/creation; the remainder is the primitive.

## S8 ledger items

1. Re-measure creation on the **bundled artifact** (esbuild collapses the
   remaining module-boundary costs; the tsx numbers above carry loader
   tax in both columns but re-verify anyway).
2. Track the FR primitive across Node/V8 versions — if
   `FinalizationRegistry.register` gets cheaper upstream, the numbers
   improve with no code change.
3. Per-class death variance (Atom +153 / Computed +420 / ReducerAtom
   +630 ns/item under a 50k-node death storm) is GC-side and inherent to
   final shapes + finalizer work; steady-state apps do not see death
   storms. Revisit only if a real workload profile surfaces it.
