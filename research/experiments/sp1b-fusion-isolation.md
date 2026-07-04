# SP1b — fusion isolation: call boundary vs storage in the SP1 host-callback tax

Pre-registered follow-up to [SP1](./sp1-host-callback-tax.md) (NOTES row SP1b
in design-loop/NOTES/OPEN.md). SP1 measured a closed-kernel host-callback tax
of deep 1.06x / broad 1.06–1.09x / diamond 1.02x / reads 1.09x vs the donor,
but that measurement bundled two effects: (a) the **call boundary** — host
upcalls out of the kernel plus kernel-accessor calls from policy code — and
(b) the **storage change** — packed side columns (`vals[id >> 2]`, kind bits
in the flags word) replaced by a handle-indexed entity-object table
(`ents[M[id + HANDLE]]`, kind in the entity). SP1b isolates them.

**Verdict: fused ≈ host on every shape. The SP1 tax is the STORAGE change,
not the call boundary — codegen fusion recovers essentially none of it.
Entity-table designs pay the tax regardless of how the dispatch is compiled.**

## What was built

`libs/arena-host-fused` — arena-host with the call boundary fused away and
storage untouched. It is the donor's single-closure engine shape holding
arena-host's storage and semantics EXACTLY:

- KEPT from arena-host (storage + semantics, unchanged): the `C.HANDLE`
  field in every node record; the dense handle-indexed entity table with the
  single hidden class `{kind, value, pending, fn, cleanup}` (slots recycled
  in place, handle free list); kind dispatch via `ent.kind` — NO kind bits in
  the kernel flags word (only upstream's six semantic bits plus policy-owned
  bit 64); the handle load `M[id + C.HANDLE]` on every dispatch; entity
  reclamation in `sweepPendingFree`; the public wrappers that cache
  `(id, handle)` pairs.
- FUSED (the only change): kernel and policy are one closure. The
  `refresh`/`notify`/`unwatched` host upcalls become direct same-closure
  calls (`update(dep)` from checkDirty, `notify(sub)` from
  propagate/shallowPropagate, `unwatched(dep)` from unlink), each loading
  `ents[M[node + C.HANDLE]]` inline; policy code touches `M[...]` directly
  instead of going through kernel accessor functions (`kGetFlags`, `kSubs`,
  `kLink`, ...). arena-host's `watched` upcall is a policy no-op, so its
  fused splice is empty — linkInsert matches the donor's (each splice point
  is marked `FUSION POINT` in the source).
- PRESERVED donor disciplines: flag ladder and walk structure, the
  link/linkInsert fast/slow split, closure-const buffer binding,
  premultiplied ids, persistent scratch stacks with base-pointer
  save/restore, growth-by-closure-rebuild, deferred reclamation with
  generation counters, same-file const enums.

Files: `libs/arena-host-fused/src/index.ts`, adapter
`harness/adapters/arena-host-fused.ts` (registered in
`harness/adapters/index.ts`). `libs/arena` and `libs/arena-host` were not
modified.

## Conformance (measured 2026-07-04, before any benchmarking)

- `FRAMEWORK=arena-host-fused pnpm -C harness conformance` → **179/179
  passed** (FRAMEWORK env verified live: a bogus name fails the suite).
- Growth stress `ARENA_INITIAL_RECORDS=2` → **179/179**.
- `pnpm -C harness bench --frameworks arena-host-fused --suites dynamic`
  (`testPullCounts: true`) → exit 0, zero console.assert failures →
  **exact pull counts** verified.
- `tsc --noEmit` clean.

## Measurement

Same tier-0 harness as SP1 (`harness/bench/shapes.ts`), one framework per
child process, driven via the child env protocol so duplicate-framework
children don't collapse. Checksums cross-verified across all children — no
mismatches. Node v24 via tsx children, macOS/arm64, load average ~2–4
(design workflow running; not idle — ratios within a session and the ABBA
ordering are the product).

### Primary: scale 5, reps 20, 6 independent children per framework, ABBA

Two mirrored 9-child sessions (A B C / C B A / A B C, then C B A / A B C /
C B A; A=donor, B=arena-host, C=fused), aggregated best-of-6 min and
mean-of-6 per-child means. Run 1's per-framework min spread was 4–11% on
some shapes (above SP1's ±1–2% bound), so run 2 was executed as a scheduled
rerun; run 2 spreads were mostly ≤3% and — decisively — the host/donor and
fused/donor ratios agree between the two runs on every shape.

| shape | donor min (ms) | host min | fused min | **host/donor min** | **fused/donor min** | donor mean | host mean | fused mean | host/donor mean | fused/donor mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deep | 14.93 | 15.96 | 16.06 | **1.07** | **1.08** | 16.26 | 17.06 | 17.05 | 1.05 | 1.05 |
| broad | 18.06 | 18.97 | 19.13 | **1.05** | **1.06** | 19.18 | 20.35 | 20.43 | 1.06 | 1.07 |
| diamond | 5.49 | 5.44 | 5.44 | **0.99** | **0.99** | 6.02 | 6.14 | 6.14 | 1.02 | 1.02 |
| reads | 27.01 | 30.19 | 29.93 | **1.12** | **1.11** | 28.73 | 33.36 | 31.60 | 1.16 | 1.10 |
| create | 32.15 | 35.17 | 34.56 | **1.09** | **1.08** | 45.14 | 46.05 | 47.15 | 1.02 | 1.04 |

(create's mean is GC-dominated in all three frameworks — ~200–250 ms total
GC per child in each — so its min ratio is the allocation-path signal, as in
SP1.)

### Component breakdown (min ratios, primary)

boundary component = host/fused (what fusion removes); storage component =
fused/donor (what fusion cannot remove).

| shape | total SP1b tax (host/donor) | boundary (host/fused) | storage (fused/donor) |
| --- | --- | --- | --- |
| deep | 1.07 | 0.99 | 1.08 |
| broad | 1.05 | 0.99 | 1.06 |
| diamond | 0.99 | 1.00 | 0.99 |
| reads | 1.12 | 1.01 | 1.11 |
| create | 1.09 | 1.02 | 1.08 |

The boundary component is 0.99–1.02 everywhere — indistinguishable from
noise. The storage component is the whole tax on every shape.

### Secondary: scale 1, reps 20, write/isolate/dynamic, 6 children per framework

Six ABBA-ordered children per framework in one session (best-of-6 min).
Scale-1 absolute times are 0.2–2.6 ms, so these are noisier (per-framework
min spread 3–23%); directional only.

| shape | donor min (ms) | host min | fused min | host/donor min | fused/donor min | host/fused min |
| --- | --- | --- | --- | --- | --- | --- |
| write | 1.408 | 1.494 | 1.456 | 1.06 | 1.03 | 1.03 |
| isolate | 2.202 | 2.554 | 2.518 | 1.16 | 1.14 | 1.01 |
| dynamic | 0.214 | 0.236 | 0.221 | 1.11 | 1.03 | 1.07 |

isolate — SP1's clearest quiet-path signal (+7–15% there) — reproduces at
host 1.16 / fused 1.14 with the tightest spreads of the three: the
quiet-read/link-path tax is also storage, not accessor-call boundary. write
and dynamic hint at a small boundary component (host/fused 1.03–1.07) but
their sub-ms times and 10–23% spreads put that within noise; the primary
scale-5 table (boundary 0.99–1.02) is the citable measurement.

## Interpretation per the pre-registered decision rule

**fused ≈ host** (host/fused within ±2% on every shape, both primary runs
agreeing) ⇒ **the tax is the storage change and fusion won't save it:
entity-table designs pay it regardless.** A codegen fusion build step buys
approximately nothing here — the four-upcall host protocol with const-bound
monomorphic callbacks (arena-host) was already as cheap as same-closure
calls. What costs 5–12% is replacing packed side columns + kind-bits-in-flags
with a handle-indexed entity-object table:

- one extra dependent Int32Array load per dispatch (`M[id + C.HANDLE]`)
  followed by an object-array element load and field loads from a heap
  object (vs `vals[id >> 2]` straight off the already-loaded id);
- kind dispatch via `ent.kind` field load + compare (vs a bit test on the
  flags word the walk already loaded);
- values scattered across per-node heap objects instead of one packed
  array (locality on reads; one object allocation per node on create).

Consequence for the two-kernel design question (SP1/O2): a closed integer
kernel with host callbacks is NOT performance-blocked by the callback
protocol itself. If a two-kernel design keeps donor-style packed side
columns addressed by kernel id (i.e. the policy's storage is index-aligned
with the kernel's plane instead of handle-indirected entity objects), the
SP1 tax should largely disappear — that variant (SP1c: closed kernel +
packed policy columns, no entity table) is the natural next spike if the
two-kernel path stays live. What is ruled out is recovering the tax by
fusing dispatch over an entity-table representation.

## Caveats

- Machine not idle (design workflow running; loadavg ~2–4). Mitigations:
  ratios within session, ABBA ordering, 6 children per framework across two
  mirrored sessions, donor as in-session control, run-to-run ratio agreement
  (every primary ratio within ±0.02 between run 1 and run 2). Absolute ms
  are not comparable to SP1's table (different load); ratios are.
- Per-framework min spread exceeded SP1's ±1–2% on several cells (up to
  11% on create/reads under load). The deltas we lean on (host vs fused)
  are 0–2% — smaller than that spread per cell, so the "boundary ≈ 0"
  claim rests on its consistency across 10 primary cells and both runs,
  all agreeing fused ≈ host, not on any single pair. The claim "storage
  ≈ full tax" (5–12%) is well above the noise.
- diamond shows no tax in either variant this session (SP1 saw 1.02) —
  consistent with its kernel-walk-dominated profile; the difference from
  SP1 is within noise.
- Fusion here is hand-splicing, which is what a codegen step would emit for
  THIS policy; a policy with non-empty `watched` or megamorphic kinds could
  behave differently.
- Not run: milomg suites, bun/JSC (same scope as SP1).

## Reproduce

```sh
FRAMEWORK=arena-host-fused pnpm -C harness conformance
ARENA_INITIAL_RECORDS=2 FRAMEWORK=arena-host-fused pnpm -C harness conformance
pnpm -C harness bench --frameworks arena-host-fused --suites dynamic
# three-way, child protocol directly (duplicate frameworks collapse in the
# parent table, so spawn children yourself for ABBA with repeats):
cd harness
SHAPES_FRAMEWORK=arena SHAPES=deep,broad,diamond,reads,create \
  SHAPES_SCALE=5 SHAPES_REPS=20 pnpm exec tsx bench/shapes.ts  # etc.
# or single-child-per-framework table:
pnpm exec tsx bench/shapes.ts --frameworks arena,arena-host,arena-host-fused \
  --shapes deep,broad,diamond,reads,create --scale 5 --reps 20
```
