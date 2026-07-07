# Why cosignal beats dalien-signals on allocation/churn — attribution and backport

2026-07-07. Node v24.16.0, macOS (darwin 25.5.0), Apple Silicon. All measurements
same-session interleaved A/B unless noted; milomg methodology (median-of-10,
no event-loop yield inside the rep loop) reproduced exactly.

## TL;DR

The kairo/updateSignals parity was real: the two kernels' propagate/flush hot
paths are equivalent. The whole creation-suite gap is **policy-layer, not
kernel**, and it decomposes into exactly two causes:

1. **createSignals (2.1x gap): `FinalizationRegistry.register` on every signal
   mint.** cosignal never reclaims signal/computed records (handles own them,
   dropped Atoms leak their 32-byte record + pinned value forever); dalien
   registers every signal handle at mint. The register call is ~12 ns/mint of
   pure CPU plus in-window GC weak-cell interaction — ~2.2 ms per 100k-mint
   rep, i.e. ~100 % of the gap.
2. **createComputations (1.28x gap): seed-shape sampling on the effect-mint
   path — and it runs TWICE per effect/scope mint.** `makeEffect` calls
   `shared.maybeSeed(fn, Callback)` and then `newEffect` (which it delegates
   to) samples the same fn again. Each call is an unconditionally-executed
   cross-scope call + counter r/m/w, ~4 ns; ~8 ns/mint on a ~30 ns mint.

Handle representation is NOT a cause: with registration ablated, dalien's
closure handles mint FASTER than cosignal's class instances (3.7 vs 4.3 ms
median same-session). Capacity/preallocation is not a cause either (dalien's
arena is larger; both bump-allocate the same way).

The backport (two changes to `src/system.ts`, no public API change):

- **Signals register for reclamation at first use** (first tracked read or
  first write) instead of at mint — the exact policy dalien already ships for
  computeds ("registration is deferred to the first evaluation ... create-heavy
  workloads skip the registry entirely"). A minted-and-dropped never-used
  signal now leaks only its 32-byte record (+ pinned initial value), which is
  strictly better than cosignal's leak-always policy.
- **Seed sampling moves behind an engine-local countdown** (`--seedGas === 0`),
  one site per mint funnel, preserving the exact 1,2,4,7,11,17… sampling
  cadence and all seeding behavior at ~1 ns/mint instead of ~8.

Result (same-session, min of 3 interleaved rounds, real milomg suites):
createSignals 2.38 ms vs cosignal's 3.58 (0.67x — dalien now WINS by 33%),
createComputations 1.07x, cellx 1.10x, dynamic 0.94–1.10x. Every
creation/churn ratio lands at or inside the ~10% target; the residual
cellx/dynamic tail is a kernel pull-path structure delta (profiled below),
not allocation.

Validation: dalien's own suite 287/287 green before and after; 179/179
conformance green before and after.

## Field reproduction

`pnpm -C harness bench --frameworks alien-v3,dalien,cosignal --suites sbench,cellx,dynamic`
(2026-07-07, harness/results/2026-07-07T01-12-03-*):

| suite/test | alien-v3 | dalien | cosignal | dalien/cosignal |
|---|---|---|---|---|
| sbench/createSignals | 9.38 | 5.58 | 2.61 | 2.14x |
| sbench/createComputations | 75.20 | 45.19 | 35.33 | 1.28x |
| sbench/updateSignals | 307.75 | 244.86 | 244.37 | 1.00x (tied) |
| cellx/cellx1000 | 5.58 | 5.58 | 4.64 | 1.20x |
| cellx/cellx2500 | 15.60 | 14.94 | 12.38 | 1.21x |
| dynamic/2-10x5 lazy80% | 140.45 | 155.05 | 133.02 | 1.17x |
| dynamic/6-10x10 dyn25% lazy80% | 117.77 | 109.39 | 92.44 | 1.18x |
| dynamic/4-1000x12 dyn5% | 315.69 | 297.71 | 273.91 | 1.09x |
| dynamic/25-1000x5 | 403.83 | 335.61 | 284.72 | 1.18x |
| dynamic/3-5x500 | 88.66 | 84.04 | 66.03 | 1.27x |
| dynamic/6-100x15 dyn50% | 195.97 | 165.43 | 160.76 | 1.03x |

A second harness run reproduced createSignals 5.64/3.52 and
createComputations 45.10/35.81 — the gap is stable.

**Methodology trap that cost half a day:** the gap only exists under milomg's
exact loop structure. milomg's `sBench.run` never yields to the event loop
inside its 10-rep loop (one `await nextTick()` before the loop, then 10
synchronous reps with `gc();gc()` between). With a yield added between reps,
dalien's registry callbacks/maintenance drain and base ties cosignal
(2.7 vs 2.8 ms). Probe drivers must reproduce the no-yield loop or they
measure a different (friendlier) regime. Also: benchmark drivers must be
esbuild-bundled with `keepNames: false` like the harness — running through
tsx adds ~120 ns/handle of keepNames tax to every closure and masks
everything (35 ms vs 2.6 ms on createSignals).

## Decomposition by ablation

Probe copies of `packages/dalien-signals/src` (verified indistinguishable from
the real source in the same bundle: `dalien-src` 5.78/5.97 vs `base`
6.24/6.22 on createSignals). All numbers same-session interleaved medians,
milomg-exact loop, 100k ops per rep.

### createSignals (mint 100k signal handles while dropping 100k)

| variant | median ms | Δ vs base | reading |
|---|---|---|---|
| base (= dalien) | 5.62–6.28 | — | |
| cosignal | 4.02–4.30 | −1.6 to −2.0 | the field gap |
| **noreg** (no `registry.register` at mint) | **3.72** | **−2.2** | registration ≈ 100 % of the gap; beats cosignal |
| noreg-sig (signals only) | 3.74 | −2.2 | computed-side registration irrelevant here |
| defreg (deferred, bounded 16 384, à la userspace) | 5.39 | −0.2 | registers still land in-window: no win |
| defregu (deferred, unbounded, microtask drain) | 6.65 (spiky, 18 ms reps) | worse | strong-pin → scavenge promotion, the pathology the userspace bound exists for |
| **reguse** (register at first use) | **2.18** | **−4.0** | never-used mints skip the registry entirely |
| candidate (reguse + seedgas) | 2.76 | −3.5 | |

Micro-decomposition of the mint itself (200k-op loop, median):
closure mint 13.1 ns; + `registry.register` 24.7 ns (+11.6); + `new WeakRef`
320 ns (KeepDuringJob makes WeakRef-based deferral a non-starter); + 2 plain
array pushes 14.6 ns (queueing is free — the cost that can't be deferred is
the registry itself plus what pinning does to the GC).

### createComputations (nine sbench subtests; effects, not computeds)

Per-subtest, same-session (cosignal / base / best-variant):

| subtest | cosignal | base | nosample | seedgas | candidate |
|---|---|---|---|---|---|
| create0to1 (pure effect mint) | 2.92–2.97 | 3.56–3.92 | **2.89** | 3.08 | 3.12 |
| create1to1 | 8.26 | 6.07 | — | 5.10 | 5.34 |
| create2to1 | 3.44–3.57 | 4.21–4.43 | — | — | — |
| create4to1 | 2.68–2.75 | 2.91–3.01 | — | — | — |
| create1000to1 | 2.20–2.30 | 2.07–2.11 (base faster) | — | — | — |
| create1to1000 | 4.69–7.58 | 4.83–5.95 | 5.04 | 4.77 | 5.45 |

The gap concentrates where effect mints dominate (0to1, 2to1, 1to2/4/8):
removing the double `maybeSeed` closes it entirely (create0to1: nosample 2.89
≤ cosignal 2.92). Link-walk-heavy subtests (1000to1) dalien already wins.

### Decomposition summary (share of each dalien-vs-cosignal gap)

| suite | gap (base − cosignal) | cause | share, measured by ablation |
|---|---|---|---|
| createSignals | ~1.9 ms (session-dependent 1.3–2.7) | `registry.register` at signal mint (direct ~12 ns/mint + in-window GC weak-cell effects) | **~100 %** (noreg −2.2 ms lands BELOW cosignal; nothing else moves the number) |
| createSignals | — | handle representation (closures vs classes) | **0 %** (negative: closures are faster once registration is ablated) |
| createSignals | — | capacity/preallocation config | **0 %** (dalien's arena is larger; allocNode paths near-identical) |
| createComputations | ~3.4–9.9 ms | double `maybeSeed` per effect/scope mint + its cross-scope call cost | **~100 %** of the effect-mint delta (create0to1 closes from 1.26x to 0.99x) |
| cellx (1.13–1.21x) | ~0.7–2.5 ms | cold first-pass propagation over fresh graph incl. build's 4k computed cold-eval registry cells; steady-state iter delta is kernel (0.52 vs 0.43) | partially closed (candidate 1.10x); residual is pull-path structure |
| dynamic (1.03–1.27x) | 5–40 ms | kernel read/link/write structure (epoch-stamp maintenance, out-of-line `link`), zero allocation involvement | not a policy issue; candidate ≤1.10x under load, residual documented below |

### cellx and dynamic

- cellx's field metric times ONE cold read+batch-write+read pass immediately
  after building 1000 layers (4k computeds + 4k effects) in the same no-yield
  task. Steady-state split (10 warmed reps): build ≈ equal (0.50 vs 0.49),
  iter 0.52 vs 0.43 — most of the 1.2x field ratio is the cold first pass over
  a fresh graph with build residue (incl. 4k computed cold-eval registry
  cells) in young gen.
- dynamic never mints in the timed loop (`runGraph` = batched write + leaf
  pulls). Same-session base/cosignal ratios: 1.14, 1.18, 1.06, 1.14, 1.24,
  1.04. This is a genuine kernel pull-path delta (global epoch-stamp
  read fast path goes cold after every write; `computedReadWith` carries the
  whole revalidation chain inline), NOT an allocation/policy issue — see
  "what was not backported".

## The backport

Two changes to `packages/dalien-signals/src/system.ts` (patch below, applied
and validated on a probe copy). `packages/dalien-signals` is read-only in
this tree, and `packages/dalien-signals-userspace` was ruled out as an apply
target twice over: at session start it had uncommitted changes by others (a
bounded register-drain diff, since committed as 329ce09), and it is under
active concurrent development by another agent (three new commits landed
mid-session) on a codebase that has structurally diverged from dalien main —
it already ships deferred+bounded registration and has no `maybeSeed` at all,
so this patch's target sites don't exist there. The patch therefore ships in
this report, against `packages/dalien-signals` @ 2dfae6a.

### 1. Signals register at first use (mint → first tracked read or write)

`makeSignal` no longer calls `shared.registry.register(oper, id)` at mint.
The handle carries a `registered` context flag; the first write or the first
read with `activeSub !== 0` registers. This is the same policy the package
already documents for computeds (registration at first evaluation;
"create-heavy workloads skip the registry entirely for computeds they never
use"), extended to signals.

Semantics delta (documented, strictly narrower than cosignal's): a signal
minted and dropped WITHOUT ever being written or tracked-read leaks its
32-byte record and pins its initial value. Any signal that ever participates
in the graph reclaims exactly as before. Edge cases audited:
- `reset()`: calling a pre-reset handle was already documented UB; an unused
  pre-reset handle dropped after reset registers nothing (before: registered
  cell whose callback self-disarms). No new hazard.
- growth/retirement: handles of a retired generation that were never used
  while it was live miss their registration (old generation's `activeSub`
  binding is frozen at 0) and degrade to the same documented leak; first
  WRITE still registers correctly in any generation (ids survive growth
  verbatim). No crash class.
- registry weak target is the handle itself; the handle's context now
  self-references the handle — an ordinary cycle, collected together, the
  registry still fires.

### 2. Seed sampling behind an engine-local gas countdown

- The redundant second sample is removed: `makeEffect`/`makeScope` no longer
  call `maybeSeed` (their `newEffect`/`newScope` funnels sample once).
- Every remaining sample site is gated on `if (--seedGas… === 0)` where
  `seedGas…` are engine-local (per-family) countdowns refilled by
  `maybeSeed`'s return value. Sampling cadence is bit-identical
  (mints 1, 2, 4, 7, 11, 17, …); a fresh engine generation re-samples once at
  its first mint (~0.2 µs, once per growth). Per-mint cost drops from two
  cross-scope calls + counter r/m/w to one context-slot decrement + branch.

### Patch

Apply with `git apply backport.patch` from the dalien-signals package root
(also archived at `/Users/jitl/.claude/jobs/2e4b7274/tmp/backport.patch`;
the applied file is `/Users/jitl/.claude/jobs/2e4b7274/tmp/probes/candidate/system.ts`,
whose base is packages/dalien-signals @ 2dfae6a).

```diff
--- a/src/system.ts
+++ b/src/system.ts
@@ -546,7 +546,7 @@
 	hostStop: ((id: NodeId, js: unknown, state: unknown) => void) | undefined;
 	growPending: boolean;
 	boundaryPending: boolean;
-	maybeSeed(fn: Function, family: number): void;
+	maybeSeed(fn: Function, family: number): number;
 	grow(): void;
 	boundaryWork(): void;
 	scheduleMaintenance(): void;
@@ -734,22 +734,21 @@
 	const seedSampleAt = [1, 1]; // next mint (per family) to sample
 	const seedSrcs: (string | undefined)[] = [undefined, undefined];
 	let seeded = false;
-	function maybeSeed(fn: Function, family: number): void {
-		if (seeded || ++seedMints[family] !== seedSampleAt[family]) {
-			return;
-		}
-		if (seeding === 'off') {
-			return;
+	function maybeSeed(fn: Function, family: number): number {
+		if (seeded || seeding === 'off') {
+			return 1 << 30;
 		}
+		seedMints[family] = seedSampleAt[family];
 		seedSampleAt[family] += (seedSampleAt[family] >> 1) + 1;
+		const gas = seedSampleAt[family] - seedMints[family];
 		const src = String(fn);
 		const seen = seedSrcs[family];
 		if (seen === undefined) {
 			seedSrcs[family] = src;
-			return;
+			return gas;
 		}
 		if (src === seen || configuredRecords < 4096) {
-			return;
+			return gas;
 		}
 		seeded = true;
 		// The warmup is engine-internal: its transient nodes and effect runs
@@ -772,6 +771,7 @@
 			shared.hostStart = savedStart;
 			shared.hostStop = savedStop;
 		}
+		return 1 << 30;
 	}
 
 	function seedEngine(): void {
@@ -1189,6 +1189,11 @@
 		return f;
 	}
 
+	// Seed-sampling gas: countdown to the next maybeSeed sample per family.
+	// Engine-local so the per-mint cost is one context-slot decrement+branch.
+	let seedGasGetter = 1;
+	let seedGasCallback = 1;
+
 	// Local aliases for the shared side arrays (stable identities): one load
 	// at construction, then context-specialized constants in the hot paths.
 	const vals = shared.values;
@@ -1255,16 +1260,26 @@
 				return shared.inner!.makeSignal(initialValue);
 			}
 			const id = newSignal(initialValue);
+			let registered = false;
 			const oper = anon(((...value: [unknown?]): unknown => {
 				if (value.length) {
+					if (!registered) {
+						registered = true;
+						if (shared.registry !== undefined) {
+							shared.registry.register(oper, id);
+						}
+					}
 					write(id, value[0]);
 				} else {
+					if (!registered && activeSub !== 0) {
+						registered = true;
+						if (shared.registry !== undefined) {
+							shared.registry.register(oper, id);
+						}
+					}
 					return read(id);
 				}
 			}) as SignalHandle);
-			if (shared.registry !== undefined) {
-				shared.registry.register(oper, id);
-			}
 			return oper;
 		}
 
@@ -1275,7 +1290,9 @@
 		// -> handle), making the FinalizationRegistry unable to ever fire —
 		// upstream has no such anchor because its whole graph is GC-traceable.
 		function makeComputed(getter: (previousValue?: unknown) => unknown): () => unknown {
-			shared.maybeSeed(getter, SeedFamily.Getter);
+			if (!--seedGasGetter) {
+				seedGasGetter = shared.maybeSeed(getter, SeedFamily.Getter);
+			}
 			maybeBoundary(); // may grow, retiring this engine
 			if (retired) {
 				return shared.inner!.makeComputed(getter);
@@ -1291,7 +1308,6 @@
 		}
 
 		function makeEffect(fn: () => (() => void) | void): () => void {
-			shared.maybeSeed(fn, SeedFamily.Callback);
 			maybeBoundary(); // may grow, retiring this engine
 			if (retired) {
 				return shared.inner!.makeEffect(fn);
@@ -1304,7 +1320,6 @@
 		}
 
 		function makeScope(fn: () => void): () => void {
-			shared.maybeSeed(fn, SeedFamily.Callback);
 			maybeBoundary(); // may grow, retiring this engine
 			if (retired) {
 				return shared.inner!.makeScope(fn);
@@ -2378,7 +2393,9 @@
 			if (retired) {
 				return shared.inner!.newComputed(getter);
 			}
-			shared.maybeSeed(getter, SeedFamily.Getter);
+			if (!--seedGasGetter) {
+				seedGasGetter = shared.maybeSeed(getter, SeedFamily.Getter);
+			}
 			const id = allocNode(C.K_COMPUTED);
 			fnTab[id >> 3] = getter;
 			return id;
@@ -2388,7 +2405,9 @@
 			if (retired) {
 				return shared.inner!.newEffect(fn);
 			}
-			shared.maybeSeed(fn, SeedFamily.Callback);
+			if (!--seedGasCallback) {
+				seedGasCallback = shared.maybeSeed(fn, SeedFamily.Callback);
+			}
 			const e = allocNode(C.K_EFFECT | C.WATCHING | C.RECURSED_CHECK);
 			fnTab[e >> 3] = fn;
 			const prevSub = activeSub;
@@ -2414,7 +2433,9 @@
 			if (retired) {
 				return shared.inner!.newScope(fn);
 			}
-			shared.maybeSeed(fn, SeedFamily.Callback);
+			if (!--seedGasCallback) {
+				seedGasCallback = shared.maybeSeed(fn, SeedFamily.Callback);
+			}
 			const e = allocNode(C.K_SCOPE | C.MUTABLE);
 			const prevSub = activeSub;
 			activeSub = e;
```

## Before/after (final same-session A/B, min of 3 interleaved rounds)

All three libs interleaved per round, three rounds, real milomg suites
through the probe driver (min across rounds; per-round medians in
`final-ab.txt`). Ambient load this session compressed the base-vs-cosignal
createSignals gap relative to the harness field runs (see per-session numbers
above); within-session ordering is what matters here.

| suite/test | cosignal | base (=dalien) | candidate | base/cos | cand/cos | cand/base |
|---|---|---|---|---|---|---|
| createSignals | 3.58 | 3.73 | **2.38** | 1.04 | **0.67** | 0.64 |
| createComputations | 35.73 | 39.08 | 38.06 | 1.09 | 1.07 | 0.97 |
| updateSignals | 239.30 | 256.75 | 260.31 | 1.07 | 1.09 | 1.01 |
| cellx1000 | 5.47 | 6.19 | 6.04 | 1.13 | 1.10 | 0.98 |
| cellx2500 | 13.53 | 15.62 | 14.89 | 1.15 | 1.10 | 0.95 |
| dynamic 2-10x5 lazy80% | 182.23 | 162.60 | 170.97 | 0.89 | 0.94 | 1.05 |
| dynamic 6-10x10 dyn25% lazy80% | 118.72 | 116.10 | 114.73 | 0.98 | 0.97 | 0.99 |
| dynamic 4-1000x12 dyn5% | 314.83 | 331.75 | 330.14 | 1.05 | 1.05 | 1.00 |
| dynamic 25-1000x5 | 345.17 | 380.48 | 370.17 | 1.10 | 1.07 | 0.97 |
| dynamic 3-5x500 | 81.31 | 87.70 | 89.67 | 1.08 | 1.10 | 1.02 |
| dynamic 6-100x15 dyn50% | 175.83 | 172.73 | 170.28 | 0.98 | 0.97 | 0.99 |

Cleaner-load sessions earlier the same day (same driver, interleaved) put the
creation deltas in sharper relief — createSignals: cosignal 4.02 / base 6.21 /
candidate 2.76; create0to1: cosignal 2.97 / base 3.56 / candidate 3.12;
create1to1: cosignal 8.26 / base 6.07 / candidate 5.34.

Final confirmation on the lint-clean patch (two interleaved rounds, custom
milomg-exact shapes, medians):

| shape | cosignal | base | candidate | cand/cos |
|---|---|---|---|---|
| createSignals (r1 / r2) | 4.04 / 3.86 | 5.95 / 6.77 | 2.67 / 2.59 | 0.66 / 0.67 |
| create0to1 (r1 / r2) | 2.93 / 2.86 | 3.39 / 3.36 | 3.07 / 3.01 | 1.05 / 1.05 |

Two second-order effects worth naming honestly:
- **reguse relocates (does not add) register cost**: the createComputations
  subtests that first-link fresh sources in-window (1to1, 2to1, 4to1,
  1000to1) absorb ~+1 ms/100k-links each that base paid at (untimed) mint
  time; seedgas's ~−4 ms nets createComputations to −1 ms vs base. Total
  registry work per signal is unchanged — it just amortizes at first use.
- **updateSignals**: +1.4% vs base (the once-per-handle `registered` branch on
  the read/write paths). Field methodology (harness) had dalien/cosignal tied
  at 243/244; the probe driver consistently shows base ~7% behind cosignal
  here regardless of the patch — a driver artifact, tracked but not chased.


## Validation

| check | before (dalien pristine) | after (candidate) |
|---|---|---|
| dalien's own suite (`vitest run`, 18 files) | 287/287 pass | 287/287 pass |
| reactive-framework-test-suite conformance | 179/179 pass (`FRAMEWORK=dalien pnpm -C harness conformance`) | 179/179 pass (same suite over the patched probe) |
| dalien's `check` script (`tsslint --project tsconfig.json`) | pass | pass, 0 messages |
| dalien's `build.js` (esm/cjs/types) | pass | pass |

The reclaim tests (`tests/reclaim.spec.ts`) pass unmodified after the change
because their signals are tracked-read by computeds before being dropped —
i.e. they exercise the new first-use registration path, and reclamation
still works.

## What was NOT backported (and why)

- **Dropping reclamation entirely (cosignal's policy).** noreg matches
  cosignal's numbers, but silently leaking every dropped signal betrays the
  package's design contract; reguse gets more win (never-used mints are free,
  used mints amortize the 12 ns over their lifetime) without giving up
  reclamation for anything that touches the graph.
- **Deferred/batched registration.** Bounded batching (userspace's
  `REGISTER_DRAIN_THRESHOLD` design) re-pays the full register cost in-window
  — measured no-op here (5.39 vs 5.62). Unbounded deferral measured WORSE
  (6.65 median with 18 ms spikes) via strong-pin promotion — consistent with
  the package author's own note ("registration is immediate — every batching
  scheme measured worse") and with the userspace uncommitted diff's rationale.
  WeakRef-held queues are non-viable (~320 ns/op, KeepDuringJob).
- **The dynamic-suite pull-path delta.** Different cause (kernel read-path
  structure: global epoch stamp misses after every write + one big inline
  `computedReadWith` vs cosignal's small `computedRead` with an out-of-line
  slow twin; the userspace campaign's "kind-specialized callable reads"
  commits are the same lever). Closing it means restructuring the computed
  read path, which is a kernel change with risk to the currently-tied
  update benchmarks — out of scope for a minimal creation/churn backport.
  Profile evidence (full dynamic suite, self-time): base spends
  3062 ms in `read` + 962 ms `write` + 448 ms `link` vs cosignal's 2056 +
  366 + 11 (cosignal's linking is inlined into its small `read`); cosignal
  instead concentrates 717 ms in `propagate` (vs 137). dalien's per-write
  epoch bump plus per-read stamp compare/restamp (`D[(c>>1)+3]`, Float64Array
  traffic) and out-of-line `link` are the residual — worth its own campaign,
  with the update-suite parity as the regression gate.

## Probe/repro artifacts

- Probe copies + ablation variants: `/Users/jitl/.claude/jobs/2e4b7274/tmp/probes/{base,noreg,noreg-sig,defreg,defregu,nosample,seedgas,reguse,candidate}/`
- Driver (milomg-exact shapes + real suites, esbuild-bundled keepNames-off):
  `/Users/jitl/.claude/jobs/2e4b7274/tmp/driver.ts` (+ `bundle.mjs`, `aggregate.py`)
- Patched-package test copies: `/Users/jitl/.claude/jobs/2e4b7274/tmp/testpkg-{pristine,candidate}/`
- CPU profiles (create0to1): `/Users/jitl/.claude/jobs/2e4b7274/tmp/prof/`
- Raw runs: `repro-milomg.txt`, `real-suite-ablation.txt`, `dynamic-ablation.txt`, `final-ab.txt` in the same tmp dir.

---

## ADDENDUM (2026-07-07, owner directive): first-use registration REJECTED

**Owner rule, absolute: WE MUST NEVER LEAK. Any leak is a bug. Leaking is
not a valid optimization at any bound.** This supersedes the backport
recommendation above:

- **First-use registration is rejected** — its "one 32-byte record per
  never-used dropped signal" bound is a leak, therefore a bug. Signals must
  register at MINT (total reclamation coverage). The ~12ns/mint cost is the
  price of correctness; optimize its constants (SMI heldValues, token
  strategy per handle shape — see packages/cosignals-alt-a/b, engineered to
  the measured V8 FR floor) but never trade coverage away.
- **The seedGas fix stands** (pure bug fix, no leak trade): worth ~all of
  the createComputations gap on its own.
- **cosignal's never-reclaiming handles are a BUG to fix**, not a
  performance win: its field-leading creation numbers were partly purchased
  with an unbounded leak and must be re-measured after it registers at mint.
  Benchmark comparisons in this repo must flag leak-vs-no-leak asymmetry;
  a leaking engine is disqualified from "faster," not credited.
- Corrected expectation for dalien-userspace: adopt seedGas; keep mint-time
  registration; adopt the cosignals-alt-a/b registration-constant
  optimizations. Creation will not reach 0.66x — the FR floor is the honest
  price every non-leaking engine pays equally.
