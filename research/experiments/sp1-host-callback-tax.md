# SP1 — host-callback indirection tax on the arena kernel

Spike for design-loop/NOTES/OPEN.md **O2** (pre-registered; decision rule:
>5% on recompute-dense shapes → the codegen-fusion variant must also be
measured before a two-kernel design is judged on performance).

**Verdict: the tax EXCEEDS 5% on recompute-dense shapes (deep +6%, broad
+6–9%; diamond +2%). Per the decision rule, the codegen-fusion variant must
be measured before a two-kernel architecture is judged on performance.**
D's prediction of ≤3–5% ([SPECS d §14/§15]) is contradicted on deep/broad.

## What was built

`libs/arena-host` — the donor `libs/arena` kernel re-split along upstream
alien-signals' system.ts/index.ts seam, with the kernel as a CLOSED integer
engine:

- Kernel: pure topology + flags machine over the Int32Array plane. Deleted
  from kernel code: values/fns side-column access, kind bits, and all kind
  dispatch. Preserved verbatim: flag-ladder and walk structure, the
  link/linkInsert fast/slow split, closure-const buffer binding,
  premultiplied ids, scratch-stack discipline, growth-by-closure-rebuild.
- Host protocol: exactly four callbacks registered once at kernel creation,
  const-bound inside the kernel closure (direct monomorphic calls, no
  property load per upcall): `refresh(node, handle) -> boolean`,
  `notify(node, handle)`, `watched(node, handle)`, `unwatched(node, handle)`.
  `handle` is the policy handle stored in the node record's spare field
  (one extra M load per upcall — the honest kernel-id → policy-id cost).
- Policy layer: plain Atom/Computed/effect semantics over a dense
  handle-indexed entity table with a single hidden class
  `{kind, value, pending, fn, cleanup}` (slots recycled in place). Policy
  reaches the kernel only through const-bound kernel operations
  (link/unlink/propagate/checkDirty/shallowPropagate/purgeDeps/
  disposeAllDepsInReverse) and tiny field accessors.

Files: `libs/arena-host/src/index.ts`, adapter
`harness/adapters/arena-host.ts` (registered in `harness/adapters/index.ts`).
`libs/arena` was not modified.

## Conformance (measured 2026-07-04, before any benchmarking)

- `FRAMEWORK=arena-host pnpm -C harness conformance` → **179/179 passed**
  (same as donor), untracked section real (untracked exported).
- Growth stress `ARENA_INITIAL_RECORDS=2` → **179/179**; donor under the
  same config also 179/179 (control).
- `pnpm -C harness bench --frameworks arena-host --suites dynamic` with
  `testPullCounts: true` → exit 0, zero console.assert failures → **exact
  pull counts** verified.

## Measurement

Harness: `harness/bench/shapes.ts` (the same tier-0 harness the donor's
numbers come from), one framework per child process, checksum
cross-verified between frameworks (no mismatches in any run), GC attributed
per shape via PerformanceObserver('gc'). Node v24 via tsx children,
macOS/arm64, load average 4.5–5.1 during runs (not idle — but ratios within
one invocation are the product, and per-framework spread below bounds the
noise).

### Primary: scale 5, reps 20, 3 independent children per framework, ABBA order

Per-framework fastest-of-20 spread across the 3 children was ≤±1% on every
shape — differences ≥2% are above run-to-run variance.

| shape | donor min (ms) | host min (ms) | **min ratio (host/donor)** | donor mean | host mean | mean ratio | GC ms donor→host |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deep | 15.46 | 16.36 | **1.06** | 16.11 | 17.22 | 1.07 | 0.2→0.4 |
| broad | 18.56 | 19.72 | **1.06** | 19.04 | 20.77 | 1.09 | 0.1→0.0 |
| diamond | 5.78 | 5.91 | **1.02** | 5.97 | 6.11 | 1.02 | 0.3→0.5 |
| reads | 27.81 | 30.39 | **1.09** | 28.58 | 31.34 | 1.10 | 0.1→0.0 |
| create | 33.56 | 37.20 | **1.11** | 48.48 | 49.03 | 1.01 | 295→224 |

(create's mean is GC-dominated in both frameworks; its min ratio 1.11 is the
allocation-path signal — the policy allocates one entity object per node
where the donor writes two packed-array slots. GC totals are comparable.)

### Secondary: scale 1, reps 20, 4 repeated pair invocations (min ratios per run)

| shape | run1 | run2 | run3 | run4 |
| --- | --- | --- | --- | --- |
| deep | 1.02 | 1.08 | 1.05 | 1.01 |
| broad | 1.08 | 1.10 | 1.07 | 1.06 |
| diamond | 1.05 | 0.98 | 1.05 | 1.07 |
| dynamic | 1.04 | 1.05 | 1.11 | 1.06 |
| reads | 1.12 | 1.12 | 1.11 | 1.10 |
| create | 1.05 | 1.08 | 1.11 | 1.07 |
| write | 1.12 | 1.16 | 1.14 | 1.13 |
| isolate | 1.07 | 1.14 | 1.11 | 1.15 |

Scale-1 absolute times are 0.2–6 ms so single-run ratios are noisy
(diamond spans 0.98–1.07); the scale-5 table is the citable one. The
consistent write (+12–16%) and reads (+9–12%) taxes show the indirection
cost is NOT confined to `host.refresh`: the policy's read/write paths paying
kernel-accessor calls (getFlags/subs/link) plus entity-object value access
instead of in-closure side-column access is where the quiet-path tax lives.

## Interpretation and caveats

- **Against the decision rule (>5% recompute-dense): deep +6% and broad
  +6–9% exceed it; diamond +2% does not.** The rule triggers → measure the
  fusion variant before judging a two-kernel design on performance.
- The measured tax bundles two things this spike could not separate:
  (a) the pure call-boundary cost of the four host upcalls + kernel-accessor
  calls from policy, and (b) the storage change from packed side columns
  (`vals[id>>2]`) to a handle-loaded entity object (`ents[M[id+HANDLE]]`).
  A fusion spike should isolate these: splice the kind dispatch back into
  checkDirty/propagate at a marked point while KEEPING the entity table, and
  compare against both this variant and the donor. The donor itself is the
  fully-fused, fully-inlined bound (0%).
- diamond's low tax is expected: its hot loop is one join recompute per wave
  behind a 50-branch propagate wave — kernel-walk-dominated, few upcalls per
  wave. deep is the opposite (100 refresh upcalls per wave), broad has 100
  notify upcalls per wave; both show the tax.
- `watched` fires only on empty→nonempty subscriber transitions (linkInsert
  slow path) and is a policy no-op here; steady-state re-tracking never hits
  it. Its cost is included but negligible in these shapes.
- Machine was not idle (loadavg ~5). Mitigations: ratios within invocation,
  3 independent children per framework ABBA-ordered, ≤±1% min spread at
  scale 5, donor run as in-session control in every invocation. No
  suspicious pair needed re-running beyond the scheduled repeats.
- Not run for SP1: full milomg suites (kairo/sbench/cellx) and bun/JSC.
  Tier-0 was the pre-registered method; kairo-scale GC-inclusive behavior of
  the entity table (object per node vs packed columns) is untested and worth
  one kairo pass if the two-kernel path stays live.

## Reproduce

```sh
FRAMEWORK=arena-host pnpm -C harness conformance
ARENA_INITIAL_RECORDS=2 FRAMEWORK=arena-host pnpm -C harness conformance
pnpm -C harness bench --frameworks arena-host --suites dynamic
cd harness && pnpm exec tsx bench/shapes.ts --frameworks arena,arena-host \
  --shapes deep,broad,diamond,reads,create --scale 5 --reps 20
```
