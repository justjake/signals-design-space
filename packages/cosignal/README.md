# cosignal

Concurrent-React-native signals on a proven data-oriented kernel. One
library, two builds:

- **DIRECT** (`cosignal`) — a standalone push-pull signals library: the
  `libs/arena` packed Int32Array kernel (179/179 alien-signals
  conformance, tier-0 at-or-better parity with the frozen donor) under a
  small policy layer: `Atom`, `ReducerAtom`, `Computed`, `effect`,
  `effectScope`, `batch`, `untracked`, `configure`. This entry's module
  graph is exactly one file and contains zero overlay code — enforced by
  test.
- **LOGGED** (`cosignal/logged`) — the same API plus the concurrent
  worlds engine (`registerReactBridge()`): write receipts on per-atom
  tapes, worlds as pure folds with two-clause visibility, a second edge
  plane (K1) carrying pending-world dependency topology, per-write
  value-blind delivery, a 31-slot batch identity table with verified
  lifecycle, per-root commit lock-in, mount fixup, and effects — the
  substrate `cosignal-react` drives from the React fork's seam events.
  With the bridge unarmed, LOGGED is semantics-identical to DIRECT
  (conformance 179/179 both ways).

Extra entries: `cosignal/trace` (zero-allocation recorder — ring and
lossless-session modes, causality queries, `attachTracer(bridge)`;
untraced cost is one slot check per site) and `cosignal/graphviz`
(dependency-graph and causal-event DOT renderers).

## Correctness story

The engine is developed against an executable oracle
(`packages/cosignal-oracle`): a naive replay model of the spec with an
invariant pack, a seeded schedule fuzzer, and a shrinker. The LOGGED
engine runs the oracle's 17-case battery, its pinned scar schedules, and
a 300×80 + 8×400-step fuzz corpus in lockstep with the model — zero
diffs, event-stream-exact. The spec is `spec/cosignal-v1.md`; the §5.10
"Oracle errata" block is normative (three corrections the model caught
in the ratified text).

## Layout

- `src/index.ts` — the DIRECT build: kernel (seven enumerated deltas
  from the donor, header comment) + policy layer. The `Engine` interface
  is the operation table; the LOGGED build swaps it once at an operation
  boundary via `__installTwinTable`.
- `src/logged.ts` — the overlay + bridge (`registerReactBridge`). Module
  doc describes the bridge surface; `TODO(gate)` markers name the
  deliberately-deferred optimizations (receipt packing, touched-word
  drains, read routing) that the SPK gate battery decides.
- `src/trace.ts`, `src/graphviz.ts` — tracing (module doc = the surface
  documentation).
- `tests/` — unit tests, the oracle twin-driver suites
  (battery/scars/flags/fuzz), twin-build isolation checks, trace suites.

## Running

```sh
pnpm -C packages/cosignal test          # full suite (fuzz corpus included)
pnpm -C packages/cosignal exec tsc --noEmit
FRAMEWORK=cosignal pnpm -C harness conformance          # DIRECT, 179 cases
FRAMEWORK=cosignal-logged pnpm -C harness conformance   # LOGGED-quiet, 179 cases
```
