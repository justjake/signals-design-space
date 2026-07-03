# Vendored library study guide

Everything vendored as git submodules under `vendor/` (plus the original
three at repo root). "Faster than alien-signals" is always **shape-
specific** — no library beats it across the suite at equal conformance;
each entry notes exactly where it wins and why.

| submodule | what | pinned at |
|---|---|---|
| `vendor/anod` | visj/anod — array-edge push-pull, sync+async core | master |
| `vendor/lite-signal` | PeshoVurtoleta/lite-signal — pooled-DLL engine (typed-array attempt in `archived/`) | 1.3.0 |
| `vendor/reactively` | milomg/reactively — canonical 3-color array core | main |
| `vendor/solid` | solidjs/solid **branch `next`** — Solid 2.0 (`packages/solid-signals`) | next |
| `vendor/svelte` | Svelte 5 runes (`packages/svelte/src/internal/client/reactivity/`) | main |
| `vendor/preact-signals` | Preact Signals (`packages/core/src/index.ts`) | main |
| `vendor/cellx` | Riim/cellx — intrusive-list push-pull | master |
| `vendor/signia` | tldraw/signia — epoch + diff propagation in production | v0.1.5 |
| `vendor/leptos` | leptos — 0.6 slotmap-arena core (git history) + 0.7 `reactive_graph/` Arc'd multithreaded core | main |

---

## anod (`vendor/anod/src/core.js`, ~4.4k lines) — the deep dive

The library that beats alien-signals on its open flank (upstream issue
#108, author-acknowledged): **wide dense updates −37% time / −89% heap,
unstable −50%, 1k signal creation −21% time / −75% heap**. Alien wins
deep (+17%), diamond (+9%), cellx (+12%), 1k computations (+23%).

**Architecture** (all in one Closure-Compiler-annotated file):

- **Edges are arrays with inline-first fields.** Every sender has
  `_sub1: Receiver|null` (inline first subscriber) + `_subs: Array|null`
  (spill) + `_tombstones` count; every receiver has `_dep1` + `_deps`.
  Degree-1 — the dominant case — never allocates an edge container at
  all (this is S.js's `source1` on *both* sides). Unsubscribe writes a
  tombstone; compaction happens lazily when `_tombstones >= subs.length`.
- **No Link objects anywhere.** A subscription is "receiver appears in
  sender's array" + stamp fields on the nodes. Where alien pays 80 B +
  4 barriered pointer stores per edge splice, anod pays an array push.
  This is the entire wide-fanout/heap story: propagation iterates a
  dense array (`for i < subs.length`) instead of chasing 80 B list nodes,
  and re-tracking reuses the arrays in place.
- **Dep reconciliation via shared scratch stacks, not allocation.**
  Module-level preallocated stacks (`VSTACK`+`REUSED` for dep replay,
  `CSTACK`/`CINDEX` for iterative checkDirty with explicit resume
  positions, `DBASE`/`DCOUNT` for collecting diverged dep sets). A new
  `_deps` array is allocated (`stack.slice(DBASE, DCOUNT)`) **only when
  the dep set actually changed**. Same-deps re-runs allocate nothing —
  alien's tail-cursor guarantee, achieved on arrays.
- **Clock + stamps instead of per-edge versions.** Global logical `TIME`;
  nodes carry `_time` (write time), `_ctime` (change time), `_stamp`
  (scratch dedup stamp; `SEED += 2` per operation gives collision-free
  stamping without clearing). Staleness = integer compares — Salsa's
  `changed_at`/`verified_at` discipline, S.js's clock, no Link.version.
- **Two-phase marking, alien-equivalent**: `FLAG_STALE` (dirty) /
  `FLAG_PENDING` (check) pushed through `_receive()`; pull side
  (`checkRun`, line ~3490) verifies pending nodes dep-by-dep in recorded
  order with the explicit-resume stack — same discipline as alien's
  checkDirty, zero recursion, zero allocation.
- **Level-bucketed phased flush.** Effects carry `_level` = ownership
  depth; the flush loop drains phases per tick: disposers → deferred
  sender updates → eager computes → `SCOPES[level]` effect queues in
  level order (`flush()`, line ~4277). Levels are a cheap topological
  proxy (Solid 1.x's `runTop` owner-walk, bucketed instead of walked).
  Errors route through per-node `_recover` handlers with
  REFUSE/PANIC/FATAL severity — error handling is *in the core*, yet the
  hot path stays flag-gated.
- **Bound mode skips tracking entirely**: `compute(dep, fn)` fixes the
  single dependency at creation (`FLAG_BOUND|FLAG_SINGLE`) — no
  reconciliation, no cursor, no stamps on re-run. The README calls it
  "significantly faster for the common single-dep case." This is a
  *semantic* lever alien doesn't expose (its tracking is always dynamic).
- **Async is first-class** (tasks/spawns/channels/suspend with
  disposal-safe `REGRET` thenable) — worth studying for API design, but
  note when benchmarking: anod's sync hot paths carry async flag checks
  and still post those numbers.
- **Context-object reads** (`c.val(sender)`) instead of a tracking
  global — explicit, monomorphic, and makes untracked reads free.

**What to steal**: inline-first edge fields both sides; tombstoned array
subs with threshold compaction; the scratch-stack reconciliation that
allocates only on divergence; stamp-based dedup (`SEED += 2`); level
buckets; bound/static-dep mode as an opt-in API.

**Semantic deltas vs alien to watch in comparisons**: no two-slot
pending/current signal values (A→B→A writes propagate), context-passing
API, effects eager-by-level rather than parent-chain queue reversal.

## lite-signal (`vendor/lite-signal/Signal.js`, 1.6k lines)

The issue-#117 library. Shipping version is a **pooled doubly-linked-list
engine** (O(1) link pool claim), three strictly-layered subsystems
(topology / ownership / propagation) with an owner-vs-observer pointer
split. Its own history is the lesson:

- The author's **typed-array graph attempt was slower and abandoned**
  (see `archived/`); dynamic-graph regressions came from re-tracking, not
  allocation.
- v1.3 fixed two regressions with exactly the mechanisms this project
  keeps converging on: a **`markEpoch` clean short-circuit** (global-
  epoch fast path: "large web app" 4900→665 ms) and **O(1) tail dedup**
  replacing an O(N) prefix scan (600-dep flip: 1373→62 ms).
- Cross-benchmarks (volynetstyle matrix) still show alien 3–8× ahead on
  topology-churn workloads. Zero-GC ≠ topology scalability.

Read it as a cautionary tale with good bones: `conformance/` and
`retracking.difftest.mjs` are also useful test material.

## reactively (`vendor/reactively/packages/core/src/core.ts`)

The canonical clean/check/dirty 3-color core on plain arrays
(`sources[]`/`observers[]`, `CurrentGets`/`CurrentGetsIndex` prefix-reuse).
**#2 in the sibling project's per-process field ranking** — its two-phase
marking recomputes less than alien on partially-read dynamic graphs
(dynamic suites ~887 vs alien-v3 ~1100). ~300 lines; the cleanest
starting skeleton for any array-core prototype.

## Solid 2.0 (`vendor/solid/packages/solid-signals/src/core/`)

The most advanced shipping design: reactively's coloring + alien-style
linked dep/sub lists + **`_height` + height-keyed min-heap dirtyQueue**
(`heap.ts`) + global `clock`/`_time` + async status bits + lanes for
optimistic transitions (`lanes.ts`). Study `core.ts` (flags:
DIRTY/CHECK/LAZY/OPTIMISTIC_DIRTY), `effect.ts`, `scheduler.ts`. This is
the only mainstream JS core doing priority-queue topological flush —
directly comparable to our height-bucket design idea, with real-world
constraints (async, transitions) already solved.

## Svelte 5 (`vendor/svelte/packages/svelte/src/internal/client/reactivity/`)

Per-node **write-version `wv` / read-version `rv`** counters resolve
MAYBE_DIRTY with one compare per dep and dedup same-run reads with no
Sets and no per-edge storage (`runtime.js` `is_dirty`, `sources.js`
`mark_reactions` with the `WAS_MARKED` re-traversal guard). Deriveds
carry `deps` arrays with `skipped_deps` prefix reuse. Batching supports
forks (async). The lightest-state version-counter design in production.

## Preact Signals (`vendor/preact-signals/packages/core/src/index.ts`)

The origin of the quad-linked Node design alien refined; still the
reference for **`globalVersion`** (one compare skips all validation in a
quiet system) and the `_version = -1` node-recycling protocol. Lazy
liveness: computeds subscribe to sources only while they themselves have
subscribers.

## cellx (`vendor/cellx/src/Cell.ts`)

actual/dirty/check states on **intrusive linked dependency lists**
(`_nextDependency`/`_nextDependent` fields on cells — no edge objects at
all, but single-membership: a cell appears in one list per direction),
microtask release queue, `_active` gating. Historically won deep-chain
synthetic benchmarks on minimal per-node work. The intrusive-field trick
only works because cellx restricts graph membership — a good reminder
that edge objects exist to allow *sharing*.

## signia (`vendor/signia/packages/signia/src/`)

Production (tldraw) **epoch core**: global `globalEpoch`; per-node
`lastChangedEpoch`/`lastCheckedEpoch` (= Salsa `changed_at`/`verified_at`
verbatim); pull validation via `haveParentsChanged` with parent-epoch
capture (`capture.ts` — parents + `parentEpochs` parallel arrays);
`isActivelyListening` liveness. Unique feature: **`computeDiff` +
`HistoryBuffer`** — a ring buffer of `[fromEpoch, toEpoch, diff]` tuples
per computed, so downstream consumers can request "changes since epoch N"
and incrementally maintain their own state (`getDiffSince`) — DBSP-lite
shipped in a drawing app. Transactions with rollback (`transactions.ts`)
ride the same epochs.

## leptos (`vendor/leptos`) — Rust, two generations of one reactive core

Study both generations (full analysis: `sources/gap-rust-ui-reactivity.md`):

- **0.6 `leptos_reactive`** (in git history, tag `v0.6.15`): the whole
  graph in a slotmap arena, user handles are Copy integer ids — "the
  closest existing alien-signals-on-a-slotmap artifact." Its `mark_dirty`
  stack-of-iterators traversal, visited-bit, and single-subscriber fast
  path transplant directly to a TS arena core.
- **0.7 `reactive_graph/`** (current tree): the retreat to Arc'd nodes +
  weak fat-pointer edges + RwLocks. Read the release notes and
  `graph/sets.rs` comments for *why* — nested-signal leaks and Send/Sync,
  **not performance** — and note the order-preserving `shift_remove`
  justification (nested-effect ordering), which constrains our edge-array
  designs too. Effects are async tasks on a 1-slot channel; algorithm is
  credited to Reactively's coloring.

---

## Cross-library scoreboard (who beats alien where, and the mechanism)

| challenger | wins vs alien | mechanism | loses |
|---|---|---|---|
| anod | wide dense −37%t/−89%h, unstable −50%, creation −21%t/−75%h | array subs iteration, no Link objects, scratch-stack retracking | deep +17%, diamond +9%, cellx +12% |
| alien 1.0-alpha | ~1.6× suite geomean (sibling ledger) | featurelessness: no cleanup/scope/innerWrite bookkeeping | conformance (v3 semantics absent) |
| reactively | partially-read dynamic suites (~887 vs ~1100) | 3-color marking recomputes less when reads are partial | most static shapes |
| cellx | deep-chain synthetics (historical) | minimal per-node work, intrusive lists | fan-out, dynamic |
| lite-signal | post-fix: its own earlier numbers | pool + markEpoch epoch gate | 3–8× behind on topology churn |
| DoD spike (in-house) | every isolated shape, creation 6× | interleaved records, free lists, kind-bit dispatch | suite scale (lifecycle), conformance |

The composite picture: alien-signals' remaining lead rests on (a) exact
re-run trimming under dynamic deps, (b) deep-chain link traversal, (c)
full-conformance semantics at near-alpha speed. Every challenger wins by
deleting either Link objects (anod, spike), verification walks (epochs:
signia/lite-signal/Preact), or features (alpha).
