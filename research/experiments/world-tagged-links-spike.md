# World-tagged kernel links (NF2) — design spike

2026-07-05. Spike for the named future mechanism NF2
(spec/react-compliance-contract.md §5): can ONE structural link mechanism
serve all worlds — per-world precise invalidation instead of the K1 union's
conservative reachability, and possibly ONE computed representation (review
F5)? Owner's criterion: **"simpler + faster long term."** Prototype lives in
this worktree at `spike/cosignal/src/index.ts` (699 added lines over HEAD's
`packages/cosignal/src/index.ts`, zero removed); tests in `spike/tests/`,
benches + raw results in `spike/bench/`.

## 1. Design chosen: per-world SEGREGATED shadow planes (not interleaved tags)

The two candidate shapes from the design discussion:

- **(i) tagged-interleaved** — speculative links live in the shared
  subscriber/dep lists, each carrying a world tag. Rejected without
  prototyping: the measured hang is an *aliasing* failure (cross-world links
  sharing one list form union cycles — logged.ts's newest-plane comment;
  battery case 1's member is per-view acyclic, union cyclic). Interleaving
  keeps the union structure and merely guards it: every kernel sync walk
  (propagate, checkDirty, shallowPropagate, the dispose walks) gains a
  per-link tag filter, the in-place reuse cursor (DEPS_TAIL) must skip
  foreign-world links, and world teardown is per-edge surgery **on the shared
  lists** — the exact walk that hung.
- **(ii) per-world planes (built)** — each world owns a plane of shadow
  records: shadow nodes mirror kernel nodes (field 5 = kernel id, field 6 =
  world id, field 7 = fanout-dedup stamp) and link records keep the exact
  kernel LinkField layout with the world id in spare field 7. Kernel (world-0)
  lists are never entered by speculative links, so: (a) newest-world walks are
  byte-identical to HEAD; (b) per-world acyclicity is structural — one
  evaluation stream per world means each world's graph obeys the kernel's own
  single-stream contract, and the NF2 dispose walk terminates by construction;
  (c) teardown can be bulk (drop the plane) or surgical (per-edge), both
  measured below.

The kernel walks are transliterated per plane (M → w.W): link/linkInsert/
unlink/purgeDeps/disposeAllDepsInReverse/propagate/shallowPropagate/
checkDirty/update — same flag transitions, no notify branch (worlds have no
effects; render pulls). Per-(node, world) in-place reuse is the kernel's own
DEPS_TAIL discipline replayed against the world's shadow record.

Touch points on shipped code (each one predictable scalar branch):
`Atom.state` + `Computed.state` route to the world while a world evaluation
frame is open (the F5-unification read seam — the SAME kernel `Computed`
objects evaluate in any world); `writeAtom` fans a changed kernel write into
each live world's shadow subs (precise per-world invalidation), with a
read-clock dedup so idle-world write storms cost O(1) per node after the
first mark.

Spike simplifications (declared, not hidden): world atom values are
newest-tracking with per-world overrides (`__worldSet`) — a stand-in for the
real fold/visibility rule; no pass pins (RT1 freezing), no receipts/
retirement interplay, no per-world suspense boxes / equality cutoff /
ctx.previous / ctx.use, no watcher deliveries. §4 prices what those add.

## 2. The hang schedule (NF2's entry criterion) — written first, red → green

`spike/tests/hang.spec.ts`: the dep-flipping computed (`flag ? a : b`)
through a middle computed, watched by a kernel effect, evaluated under two
worlds with different flag values, interleaved with kernel deliveries,
world-local invalidations, a tolerated write-inside-computed **during** a
world evaluation (propagate mid-eval), a kernel-side dep flip under live
worlds, then effect disposal (the unwatched reverse-dispose cascade) and
world teardown in both modes — with a step-capped structural validator
(`__spikeGraphCheck`: list symmetry, back-pointers, cycle caps) after every
phase.

- **Red (before any mechanism):** the suite fails on missing exports —
  written first, per the entry criterion.
- **Red (the failed design, kept pinned):** `__naiveWorldRead` reproduces the
  documented approach — world evaluation hosted on the kernel's own computed
  records (links re-tracked per world, kernel value slots absorbing world
  folds). One naive world read followed by a newest read asserts corruption:
  the kernel cache serves the other world's fold (21 where newest must be 11)
  with no invalidation separating the streams — the cache-poisoning half of
  the documented failure; the structural validator and capped walks stand
  guard for the cycle half. PASSES (corruption detected, deterministically).
- **Green (the mechanism):** terminates, per-world values correct throughout,
  kernel graph structurally sound after every phase, disposal clean, and a
  200-iteration discard-churn loop with alternating surgical/bulk teardown
  leaks zero links (surgical discard asserts `links === 0` after the walk).

Conformance smoke: the 179-case reactive-framework-test-suite passes against
the prototype with zero worlds open (182/182 with the 3 hang tests;
`spike/tests/conformance.spec.ts` asserts the zero-world premise per case).
`tsc --noEmit` clean.

## 3. Numbers (median [min..max], 5 processes × 7 reps, node 24.16, M-series;
methodology per packages/cosignal/bench/util.mjs — checksums printed, and the
eval checksums MATCH across impls: 284839488)

**(b) Sync-path neutrality** — public-API shapes; worlds are live-but-idle
speculative worlds (proto only). `head-bridge` = the SHIPPED concurrent write
path (bridge registered, atom adopted, one live batch: receipts + K0∪K1
delivery walk) as the anchor for what precise fanout replaces.

| shape (ns/op) | head | proto w0 | proto w1 | proto w4 | head-bridge |
|---|---|---|---|---|---|
| chain (16 deep + effect), per write | 300.5 [289.7..321.9] | 301.6 (+0.4%) | 304.3 (+1.2%) | 321.3 (+6.9%) | 377.4 (+25.6%) |
| fan (64 wide + agg + effect), per write | 1212.9 [1173.9..1265.9] | 1230.2 (+1.4%) | 1260.2 (+3.9%) | 1329.9 (+9.6%) | 1268.7 (+4.6%) |
| read (clean computed read) | 2.6 [2.5..3.6] | 3.1 (+0.5ns) | 3.0 | 3.0 | — |

Zero-world sync semantics are neutral within noise on any shape that does
work (chain/fan); the one real regression is **+0.5ns (~19%) on a bare clean
computed read** — the `Computed.state` routing branch (`spikeRoute !== 0`),
i.e. the price of ONE computed class. (An operation-table swap would zero it,
but index.ts's own POISON note documents +15–25% from hidden-class sharing at
`E.op` sites — the scalar branch is the cheaper trade.) The marginal cost of
LIVE idle worlds is bounded by the fanout dedup (before it: fan w4 was +48%);
1 idle world costs less than the shipped machinery's one live batch on both
shapes.

**(c) Discard churn (typeahead)** — per pass: open view, 2 divergent writes
(dep-flipping flag), evaluate 20 computeds (D≈5), discard; 3000 passes.
head = openBatch + write + passStart + evaluate(pass world) + passEnd(discard)
+ retire of the superseded batch.

| ns/pass | |
|---|---|
| head (pass memo plane) | 5339.6 [5088.3..6021.2] |
| proto, bulk discard | 5108.2 (−4.3%) |
| proto, surgical (per-edge) discard | 5383.7 (+0.8%) |

Structural teardown at React discard frequency is a non-issue: even per-edge
surgical unlinking of the whole world (95 links + 37 shadows/pass) matches
the K1/memo plane's abandonment cost end-to-end, because per-pass cost is
dominated by evaluation + world setup on both sides. (Per-world footprint:
32KB plane at churn shape, 64KB at eval shape; plane pooling would cut the
allocation share further.)

**(d) Per-world evaluation** — long-lived world over N=100 computeds × D=8
deps on 128 atoms; per round: kernel-visible write(s) + re-read all 100.
head-newest = the shipped newest memo plane (its CHEAPEST: O(1) fingerprints);
head-pass = per-round pass world (what a render pass pays today; memos die
with the pass). Round cost normalized per computed-read, writes included.

| ns/computed-read | head-newest | head-pass | proto | proto vs head-newest |
|---|---|---|---|---|
| 1 atom dirty / round | 79.0 [72.9..84.0] | 929.1 | 31.5 [30.5..33.6] | **2.5×** |
| all 128 dirty / round | 1247.8 | 1378.4 | 227.2 [214.7..262.2] | **5.5×** |
| none dirty (pure revalidation) | 12.0 | 12.5 | 16.7 [6.9..20.8] | 0.7× (proto slower) |

Decomposition: when nothing changed, the memo ladder's `checkedOp` fast path
(~12ns) and the shadow flag-check path (~17ns) are both O(1) — parity. The
win is entirely in the *dirty* path: structural PENDING/DIRTY marks +
checkDirty replace per-dependency fingerprint compare loops and refolds, and
precise fanout replaces the K0∪K1 delivery walk + receipt machinery per
write. In-place reuse verified: 50 invalidation rounds, links/plane byte-
stable (800 links, zero allocation churn). head-pass's 29× column is the
today-cost of render-pass evaluation (fresh memos per pass) — the shape churn
already covers at smaller N.

## 4. Deletes vs adds (if productionized) — honestly

**Deletes (engine, logged.ts ~3.5k lines):**
- The WorldMemo ladder: `WorldMemo` (per-dep fingerprint arrays),
  `validateMemo`/`validateMemoInner`, `passClocksQuiet`,
  `committedClocksQuiet`, per-dep `scanFp` loops (~200 lines) → shadow flags
  + wCheckDirty. Atom-level `fpOf` grounding SURVIVES (world atom values
  still derive from tapes).
- The K1 union edge log: `outSets`/`outList`/`inList` (25 refs),
  `recordEdge`/`recordWeakEdge`, `sweepK1`, edge-add bit propagation →
  per-world subs lists give precise reach. Partial: the TOUCHED word + taint
  bit survive in some form (untracked reads leave no link in ANY design;
  drains/mount-fixup coverage reads them).
- The newest-plane special case (`newestMemos`, `newestFrameTaint`): the
  newest world IS the kernel — no shadow, no memo.
- **F5 unification (the prize):** `ComputedNode`/`ComputedFn` authoring,
  cosignal-react's `makeComputedNode` shim + `previousCells` + the second
  ctx/suspense wiring — ONE `Computed` class evaluates in every world
  (demonstrated: the hang test and every bench evaluate unmodified kernel
  `Computed` objects under worlds). Two computed APIs → one.

**Adds:**
- Per-world shadow planes: allocation/growth, kernelId→shadow Map, side value
  columns, world registry, discard (~130 lines).
- **The transliterated walks (~350 lines)** — the honesty item. The kernel's
  walks close over the plane (`M`) as a closure constant for speed;
  parameterizing them over a plane argument would tax world-0 (this file's
  documented history), so the world walks are duplicated specializations.
  "One mechanism" is one *design*, two *code* specializations.
- Write fanout + read-clock dedup (one scalar branch on the sync write path;
  field-7 stamps), the two read seams (+0.5ns clean computed read).
- NOT built, required for production: world values from FOLDS (tape +
  visibility, replacing `__worldSet`); pin-gated fanout for pass worlds
  (RT1: a pinned pass must NOT see later writes — fanout skips pinned worlds,
  which is cheaper, and re-arms at resume); per-world equality cutoff,
  ctx.previous, ctx.use/suspense boxes; watcher-delivery integration;
  commit-gen re-keying for committed worlds; plane pooling; int32 read-clock
  wrap handling; the growth-mid-op reload discipline (w.W re-loaded after
  allocating calls — subtler than the kernel's boundary rule, a real bug
  class).

Net: concept count roughly flat in the engine (ladder+union+two-APIs out;
planes+fanout+per-world policy state in), code likely +300–500 lines in
cosignal and −150 in cosignal-react. The tape/receipt/slot/retirement layer
is untouched by NF2 either way.

## 5. VERDICT: MIXED — "faster" holds where it matters; "simpler" does not hold net

- **Faster: YES, proven on the world side, neutral on the sync side.**
  World evaluation 2.5–5.5× vs the cheapest shipped memo plane (29× vs
  per-pass refolds), discard churn at parity even with per-edge teardown,
  kernel-grade precision per world, zero-allocation steady-state reuse, and
  the hang schedule green by construction. Sync: +0.4–1.4% on working shapes
  (within noise), +0.5ns on bare clean computed reads, idle worlds +1–10%.
- **Simpler: NO, not on net.** What deletes (memo ladder, K1 edge log, the
  second computed API) is bought with ~350 lines of duplicated walk
  specializations plus per-world policy state still to build; the fold/
  visibility machinery all stays. The genuine simplification is the PUBLIC
  surface (F5: one computed, one authoring model) — engine internals get
  faster, not smaller.

**Recommendation:** pursue as a PERFORMANCE mechanism with an API prize, not
as a simplification — and only when world-read cost shows in real profiles
(the header's own TODO(perf) trigger). Path: (1) keep the NF2 schedule + fuzz
per-view acyclicity (entry criteria); (2) ground shadow-atom values in
tape folds (fp survives at atom granularity only); (3) pin-gate fanout for
pass worlds; (4) pool world planes; (5) per-world policy state (prev/boxes/
equality); (6) only then delete the ladder + K1 + ComputedNode. If the
owner's bar is "simpler AND faster", this spike says: faster yes, simpler
only at the API layer — call it MIXED and let profiles pull it in.
