# SPK-H / SPK-Q — K0 per-recompute hook tax and quiet-React read tax

Pre-registered micro-spikes for the round-1 winning architecture
(design-loop/rounds/round-01/synthesis.md — two-kernel: closed canonical K0 +
minimal policy hooks + always-log overlay). Decision rules from
notes-diff.md's spike queue:

- **SPK-H** (synthesis §6 hook tax): >1% on tier-0 ⇒ the two per-recompute
  hooks must be compiled out of DIRECT mode via the closure rebuild (already
  the design's mode-activation mechanism); re-measure LOGGED only.
- **SPK-Q** (synthesis §5.2 read routing): >2% ⇒ the read-path
  currentWorld/NEWEST branch moves behind a LOGGED-mode closure rebuild only.

**Verdict SPK-H: the rule TRIGGERS.** Dormant (disarmed) hook sites cost
deep **+2.5–3.5%** consistently across three independent sessions (broad
+1.7–3.4%; kairo deepPropagation +7.0%, broadPropagation +4.6% directional).
That exceeds the 1% budget on recompute-dense tier-0 shapes ⇒ DIRECT-mode
closures must not contain the hook callsites; hooks exist only in the
LOGGED-mode closure build, whose tax is a follow-up measurement.

**Verdict SPK-Q: the rule TRIGGERS, marginally.** The always-present routing
branch costs reads **+2.4% / +2.4% / +3.8%** (min ratio, three sessions —
consistently at/above the 2% line on the one shape the rule names), isolate
+1.9%, deep +1.1–2.3% ⇒ per the decision rule the branch moves behind the
LOGGED-mode closure rebuild (DIRECT read paths stay branch-free). The margin
is thin — see caveats — but the pre-registered rule reads >2% and every
session's reads cell is ≥2.4%.

Both results are *compatible with the synthesis's own remedy plan*: mode
activation was already specified as one closure rebuild; these spikes show
the rebuild must carry BOTH the hooks and the routing branch, i.e. the
"predicted ≪1%" residual-tax claim for leaving them in DIRECT is falsified.

## What was built

Two donor forks, each ONE honest delta from `libs/arena` (donor unmodified):

- **`libs/arena-spkh`** — the winner's two per-recompute hook sites
  (synthesis §6: "LOGGED K0 gains exactly two null-checked per-recompute
  callsites — `beforeRetrack(n)` (E-PRESERVE mirror while forked) and
  `afterRetrack(n)` (flag OR-in) — never per-link, never per-read").
  Implementation: two module-level `let` function refs (nullable), armed via
  exported `setRetrackHooks`; each callsite is `if (hook !== null) hook(n)`.
  Sites: `updateComputed` (before the dep-set replacement / after
  `purgeDeps`) and the dirty branch of `run` (same two positions) — every
  dep-set-replacing re-evaluation, which is what E-PRESERVE must observe.
  **Hooks DISARMED (null) for all measurements** — the spike prices the
  dormant sites in DIRECT mode.
- **`libs/arena-spkq`** — the winner's read-path world routing (synthesis
  §5.2). Implementation: module-level `let currentWorld = 0` (0 encodes both
  fast-routing worlds, NEWEST and RENDER_NEWEST — §5.1 says RENDER_NEWEST
  reads "route like NEWEST", so the check is ONE scalar compare); at the top
  of BOTH hot read paths (`read` and `computedRead`):
  `if (currentWorld !== 0) return worldRead(node)`, where `worldRead` is a
  real out-of-line call target (stub — the world-evaluation machinery is out
  of spike scope). **currentWorld stays 0 for all measurements** — the fast
  side is always taken; the spike prices the always-present branch.

Interpretation choices (the synthesis is a design doc, not a patch; these
are documented so the numbers are auditable):

1. "Per-recompute" is read as computed recompute AND effect re-run (both
   replace the node's dep set — the thing `beforeRetrack`/E-PRESERVE exists
   to see). Cold first-track paths (`computedRead`'s never-evaluated branch,
   `newEffect`) got NO hook sites: they run once per node lifetime and the
   synthesis pins "exactly two per-recompute callsites". If first-track sites
   were also required, the measured tax is a lower bound (it would grow, not
   shrink — strengthening the SPK-H verdict).
2. Hooks/`currentWorld` are module-level `let`, not closure consts: LOGGED
   arming / React pass boundaries must be observable by the live engine
   closure without a rebuild — that IS the baseline design being priced. A
   closure-const variant is precisely the "compile out via rebuild" remedy
   the rules now mandate.
3. The F(node) flag check and the freshness (serve-without-recompute) rule
   live on the branch's slow side and are never executed at NEWEST, so they
   are not modeled; only the fast-path compare is priced (SPK-Q's question).

Files: `libs/arena-spkh/src/index.ts`, `libs/arena-spkq/src/index.ts`
(donor copies; deltas marked `SPK-H` / `SPK-Q` in comments), adapters
`harness/adapters/arena-spkh.ts`, `harness/adapters/arena-spkq.ts`
(registered in `harness/adapters/index.ts`). `pnpm-lock.yaml` picked up the
two new workspace packages.

## Conformance (measured 2026-07-04, before any benchmarking)

- `FRAMEWORK=arena-spkh pnpm -C harness conformance` → **179/179**;
  growth stress `ARENA_INITIAL_RECORDS=2` → **179/179**.
- `FRAMEWORK=arena-spkq` → **179/179**; growth stress → **179/179**.
- FRAMEWORK env verified live: a bogus name fails the suite.
- `pnpm -C harness bench --frameworks <fw> --suites dynamic`
  (`testPullCounts: true`) → exit 0, zero console.assert failures for both
  variants → **exact pull counts** verified.
- `pnpm -C harness typecheck` clean (covers both libs via the adapters'
  relative imports).

## Measurement

Same tier-0 harness as SP1/SP1b (`harness/bench/shapes.ts`), one framework
per child process via the child env protocol, checksums cross-verified
across ALL children per shape (aggregator flags mismatches; none occurred).
Node v24 via tsx children, macOS/arm64, loadavg 2.5–3.4 (not idle; ratios
within a session + ABBA ordering + donor in-session control are the
product). A=donor `arena`, B=`arena-spkh`, C=`arena-spkq`.

### Primary: scale 5, reps 20, 8 children/framework (two mirrored 12-child sessions, A B C C B A ×2 then reversed)

Min = best-of-8 fastest-rep; mean = mean of per-child means; per-cell
fastest-rep spread across the 8 children was 1.1–7.3%.

| shape | donor min (ms) | spkh min | spkq min | **spkh/donor min** | **spkq/donor min** | spkh/donor mean | spkq/donor mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deep | 15.13 | 15.66 | 15.34 | **1.035** | 1.014 | 1.021 | 1.028 |
| broad | 17.78 | 18.38 | 18.11 | **1.034** | 1.019 | 1.006 | 1.004 |
| diamond | 5.43 | 5.67 | 5.35 | 1.045 | 0.985 | 1.029 | 1.009 |
| reads | 26.75 | 26.64 | 27.40 | 0.996 | **1.024** | 1.024 | 1.021 |
| create | 32.03 | 31.63 | 31.92 | 0.988 | 0.997 | 0.968 | 0.974 |

Per-session min ratios (run-to-run agreement, the SP1b discipline):

| shape | spkh/donor s1 | s2 | s3* | spkq/donor s1 | s2 | s3* |
| --- | --- | --- | --- | --- | --- | --- |
| deep | 1.035 | 1.032 | 1.025 | 1.014 | 1.011 | 1.023 |
| broad | 1.034 | 1.017 | — | 1.029 | 1.001 | — |
| diamond | 1.068 | 1.006 | — | 0.985 | 0.988 | — |
| reads | 0.996 | 1.004 | 1.011 | 1.024 | 1.024 | **1.038** |
| create | 0.988 | 1.003 | — | 0.997 | 0.995 | — |
| isolate | — | — | 0.990 | — | — | 1.019 |

\*s3 = focused session (deep,reads,isolate only; 4 children/fw, same scale/
reps, ABBA). Its absolute times differ (smaller shape set → different JIT
profile); ratios are the product.

### kairo (single bundled child per framework via `pnpm -C harness bench --suites kairo`; one run, directional)

| test | donor (ms) | spkh | spkq | spkh/donor | spkq/donor |
| --- | --- | --- | --- | --- | --- |
| avoidablePropagation | 104.66 | 103.26 | 105.05 | 0.99 | 1.00 |
| broadPropagation | 79.73 | 83.38 | 79.70 | **1.05** | 1.00 |
| deepPropagation | 32.54 | 34.82 | 35.14 | **1.07** | **1.08** |
| diamond | 74.56 | 77.13 | 76.25 | 1.03 | 1.02 |
| mux | 70.58 | 70.41 | 70.81 | 1.00 | 1.00 |
| repeatedObservers | 14.86 | 14.34 | 14.79 | 0.97 | 1.00 |
| triangle | 24.46 | 23.82 | 23.26 | 0.97 | 0.95 |
| unstable | 16.51 | 16.64 | 17.06 | 1.01 | 1.03 |
| molBench | 13.29 | 13.57 | 13.26 | 1.02 | 1.00 |

## Reading against the decision rules

**SPK-H (>1% ⇒ compile out of DIRECT): triggered.** deep is +2.5/+3.2/+3.5%
in three independent sessions — never inside 1%; broad +1.7/+3.4%; kairo's
recompute-dense tests agree (deepPropagation +7%, broadPropagation +4.6%).
The sanity cells behave: reads and create — shapes whose hot paths contain
no recompute-proportional work in DIRECT (reads never recomputes after
settling; create's cost is allocation) — show ~0%. Two dormant
module-var-load + null-compare sites per recompute are NOT free where the
recompute itself is one integer add (deep's `prev()+1` chain: 100 recomputes
per wave). The synthesis's "predicted ≪1%; recomputes are an order rarer
than link traversals" holds for link-heavy shapes (diamond's join, reads)
but not for cheap-recompute chains.

**SPK-Q (>2% ⇒ branch behind LOGGED rebuild): triggered, at the margin.**
The named target — quiet-read throughput — pays 2.4/2.4/3.8% across three
sessions, never under the line; isolate (quiet reads beside unrelated
writes) +1.9%; deep +1.1–2.3% (tracked reads inside recomputes also pass the
branch). One scalar-load + compare per read is real money on a read path
that is otherwise a flags test + link fast-path. Under a strict reading of
the rule the branch leaves DIRECT closures; even under a charitable reading
("≈2%, load-sensitive") the cheap remedy is already available — the same
closure rebuild SPK-H now requires, so the marginal cost of also swapping
the read path is zero design-wise.

Combined consequence for the winner: DIRECT mode = donor closures verbatim
(no hook sites, no routing branch — literally the donor's code), LOGGED mode
= the hooked+routed closure build. The two-kernel architecture's DIRECT-mode
"donor numbers" claim survives ONLY via that split; this spike pair prices
leaving either concession in DIRECT at 2–4% on its adversarial shape.

## Caveats

- **Machine not idle** (design workflow running; loadavg 2.5–3.4). Per-cell
  min spreads (1–7%) are comparable to the 2–4% effects being claimed; no
  single cell is trustworthy alone. The verdicts rest on cross-session
  consistency: every decision-critical cell (spkh×deep, spkq×reads) landed
  on the same side of its rule in all three sessions, with donor as
  in-session control and ABBA ordering throughout.
- **spkh×diamond disagrees between sessions** (1.068 vs 1.006): treated as
  noise, not cited. **spkq×broad** likewise (1.029 vs 1.001).
- **SPK-Q's margin is thin.** reads min ratios 1.024–1.038 against a 2%
  rule under 2–6% spreads. If the design loop wants to overturn this, an
  idle-machine rerun of reads-only with more children is the cheap test; the
  in-session consistency says it will likely re-confirm.
- **Interpretation risk (SPK-H):** if "exactly two per-recompute callsites"
  meant updateComputed only (effects excluded), the deep/broad tax would
  shrink by roughly the effect-run share (deep has 1 effect run per 100
  computed recomputes per wave — negligible; broad has 1 effect per 1
  computed — up to half). deep alone still breaks the 1% rule under that
  reading.
- **Not separated:** whether spkh's tax is the branch itself, the module-var
  load, or lost inlining headroom in updateComputed/run (V8 bytecode-budget
  effects). Irrelevant to the decision rule (any form of the dormant site is
  what was priced), relevant only if someone proposes a cheaper dormant form
  (e.g. closure-const `armed` boolean — but that is the rebuild remedy).
- LOGGED-mode cost (hooks armed, branch taken) is NOT measured here — that
  is the follow-up the SPK-H rule schedules; the world path in arena-spkq is
  a stub and throws if armed.
- kairo is a single run per framework (directional); sbench/cellx and
  bun/JSC not run (same scope as SP1/SP1b).

## Reproduce

```sh
FRAMEWORK=arena-spkh pnpm -C harness conformance
ARENA_INITIAL_RECORDS=2 FRAMEWORK=arena-spkh pnpm -C harness conformance
FRAMEWORK=arena-spkq pnpm -C harness conformance
ARENA_INITIAL_RECORDS=2 FRAMEWORK=arena-spkq pnpm -C harness conformance
pnpm -C harness bench --frameworks arena-spkh,arena-spkq --suites dynamic
pnpm -C harness bench --frameworks arena,arena-spkh,arena-spkq --suites kairo
# tier-0 with per-framework repeats: spawn children yourself (duplicate
# frameworks collapse in the parent table):
cd harness
for fw in arena arena-spkh arena-spkq arena-spkq arena-spkh arena; do
  SHAPES_FRAMEWORK=$fw SHAPES=deep,broad,diamond,reads,create \
  SHAPES_SCALE=5 SHAPES_REPS=20 pnpm exec tsx bench/shapes.ts | grep '^@@ROW'
done  # aggregate min/mean per framework from the @@ROW json
```
