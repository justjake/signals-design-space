# Packed-record authoring practices, layer splits, and precedents

Research + design analysis for the arena/cosignal work (2026-07-03). Companion to
RESEARCH.md §7b (measured constraints) and the concurrent-React signals design
spec being drafted in parallel. Three questions: (1) what makes packed-record
code maintainable, (2) where the packed/GC residency line should be drawn,
(3) how mature systems draw their bytes-layer/policy-layer line.

All toolchain claims below marked **[verified locally]** were reproduced in
this repo's exact toolchain (esbuild 0.28.1, TypeScript 6.0.3, Node 24.16 /
V8 13.x) on 2026-07-03; scripts in `/tmp/packed-test` (throwaway).

## 0. The measured constraints this must respect (from §7b + new local runs)

These are the walls; every recommendation below is checked against them.

1. **Const-enum literals or bust.** esbuild bundling demotes module-scope
   `const` to mutable `var`, costing TurboFan constant-folding: +15–21% on
   kairo (§7b). **[verified locally]** Same-file `const enum` members inline
   as literals in esbuild transform AND bundle modes, and in tsc. But
   **cross-file const enums are packaging-dependent**: esbuild *bundle* mode
   inlines them, esbuild *transform* mode (what tsx/vitest do per-file) leaves
   `C.FLAGS` as a runtime property access on an imported enum object, and
   `tsc --isolatedModules` emits `export var C = ...` with runtime accesses
   too. → **The schema constants and the hot code that uses them must live in
   the same file.** Any codegen must emit *into* the engine file (generated
   region), not into a sibling module.
2. **460-bytecode inline limit; 27-bytecode "small function" threshold;
   920 cumulative.** **[verified locally]** Node 24 defaults:
   `--max-inlined-bytecode-size=460`, `--max-inlined-bytecode-size-small=27`
   (greedy inlining for tiny functions), `--max-inlined-bytecode-size-cumulative=920`
   (total inlined bytecode per optimized function). §7b: monolithic `link()`
   at 475 bytecodes hit `kExceedsBytecodeLimit` and never inlined; typed-array
   field access ≈2× the bytecode of a named-property load. Consequences:
   (a) hand-written hot functions have hard size budgets; (b) accessor
   functions ≤27 bytecodes *can* inline greedily, but they still cost full
   calls in the unoptimized tiers, burn shared cumulative budget that deep
   engine call chains need for real helpers, and the repo has already
   measured accessor indirection as a historical loss — raw `M[id + C.X]`
   stays the hot-path idiom.
3. **Dev checks must be stripped by `define`, not by runtime constants.**
   **[verified locally]** A hot function guarded by literal `if (false) {...}`
   (what `esbuild --define:__DEV__=false` produces) generates **14 bytecodes —
   identical to the unguarded function**; Ignition folds literal-false
   branches at bytecode generation, even unminified. The same function guarded
   by `const DEV = false` at module scope generates **148 bytecodes**: the
   dead check eats ~10× the function's budget without ever executing, and
   would push hot functions over the 460/920 limits. → checked accessors and
   invariant calls are free in prod *only* under a build-time `define`.
4. **Branded number types are free and catch the real bug classes.**
   **[verified locally]** With `type NodeId = number & { readonly [Brand]: 'NodeId' }`:
   - passing a `LinkId` where `NodeId` is expected → compile error;
   - assigning a raw plane load `M[nid + C.DEPS]` to a `LinkId` variable
     without a cast → compile error (forces the author to say what the field
     holds);
   - passing an un-premultiplied record index (`3`) as an id → compile error;
   - indexing `M[id + C.FLAGS]` works with **zero casts** (branded numbers are
     subtypes of `number`; arithmetic yields plain `number`, which is exactly
     right for a flags word) and **zero emitted JS** (brands erase; only
     constructor helpers like `asNodeId` leave an identity arrow, and those
     belong at allocation sites, not hot loops — or use `as` casts, which emit
     nothing).
   The cost is honest noise: every load of an id-typed field into a local
   needs `as NodeId` / `as LinkId`. That noise is the documentation.

<!-- Q1-AUTHORING: agent evidence pending -->
## 1. Authoring practices (Q1)

*(evidence sections below are being merged from source research; see §1.1–§1.4)*

## 2. Layer split: where the packed/GC line belongs (Q2)

Three candidate residency rules, judged on (a) invariant provability,
(b) survival of adding a new node kind, (c) compatibility with §0.

### 2.1 The current cut, stated precisely (lifetime-based residency)

`libs/arena/src/index.ts` puts state whose lifetime the engine itself
creates/destroys into the Int32 plane (flags, topology links, versions,
generation counters, scratch stacks), and state with polymorphic type or
GC-managed lifetime into packed side columns aligned by id (`values`, `fns`)
plus a plain `number[]` effect queue. The rule's own header comment exposes
where it frays: *"Signal and computed records are owned by the user's handle
closures and are NOT reclaimed: dropping the last reference to a
signal/computed handle leaks its record"* — i.e. lifetime-based residency
breaks down exactly at the point where lifetime stops being deterministic
(user-held handles), and the patch (FinalizationRegistry) is a policy
decision deferred upward. That is not an indictment; it shows the rule's
real content: **"in the plane" = "the engine can prove when this dies."**

### 2.2 Type-based residency with freelists (pure substrate) — rejected

The proposal: packed layer = generic arena exposing `alloc/free/field` ops
and record schemas; the signals algorithm becomes a policy client. Three
independent reasons this is the wrong boundary *here*:

1. **The boundary cannot be a module boundary (§0.1) or a call boundary
   (§0.2).** A substrate packaged as its own module loses const-enum inlining
   under transform-mode toolchains [verified locally]; a substrate consumed
   through accessor/alloc functions re-introduces the indirection §7b already
   measured as a loss. What remains of "substrate as a package" after
   flattening it into the same file and macro-expanding its accessors is…
   a naming convention.
2. **The substrate would own the *easy* invariants and none of the hard
   ones.** Allocation invariants (freelist integrity, bump-pointer bounds)
   are ~50 lines of this engine. The invariants that actually bite are
   *temporal couplings between allocator and scheduler*: records may only be
   swept at op boundaries when the effect queue is empty (`boundaryWork`'s
   `queuedLength === 0` guard — a mid-flush free could let a new node reuse
   an id the stale queue still holds); growth may only rebuild the closure at
   `enterDepth === 0`; generation counters exist to defuse disposers racing
   reclamation. A "pure mechanism" arena must expose deferred-free hooks,
   epoch/boundary callbacks, and generation checks upward — the policy leaks
   into the mechanism's interface, which is the classic sign the line is
   drawn at the wrong altitude (the mechanism can no longer be described
   without mentioning the client's scheduler).
3. **ECS precedent is a false friend.** ECS substrates (bitECS, flecs, Bevy
   tables) profitably expose generic storage because their clients iterate
   *homogeneous* components with *externally owned* lifecycles. Our engine's
   client is one algorithm whose traversals interleave three record roles per
   step and whose lifecycle is internal. bitECS v0.4's own trajectory
   (see §3) — dropping built-in stores, keeping only the relation graph — is
   the ECS world discovering that generic storage was the *least* valuable
   layer to own.

### 2.3 Capability-based residency (what the hot walks touch goes packed)

This is the rule the project *empirically converged to* without naming it:
arena-links (§7b) proved that marking/verification walks (`propagate`,
`checkDirty`, `link`) cannot afford one dependent load off-plane per step —
"the full-arena design must keep flags/topology in the arena to win" — while
`values`/`fns` are touched only at update *leaves* (one hop per actual
recompute, amortized to zero on marking) and so may stay in GC columns.
Lifetime and capability coincide on today's fields because traversal state
(flags, links, versions) happens to be exactly the deterministic-lifetime
state, and leaf state (values, functions) is exactly the polymorphic state.

Where they diverge, capability gives the right answer and lifetime is
silent: the effect queue (deterministic lifetime, but currently — correctly —
a plain `number[]` because flush is a linear scan, not a data-dependent
walk); a hypothetical `height`/`epoch` field for scheduling (polymorphic? no;
hot in walks? yes → plane); React-integration state like subscriber
snapshots (deterministic lifetime, but touched only by the adapter → GC).

### 2.4 Verdict

**Keep lifetime-based residency as the storage rule; adopt the capability
test as the design rule; reject the substrate split.**

- *Storage rule* (mechanically checkable, drives the invariant sweeper):
  every plane record is either on a freelist or has kind bits; every plane
  field's owner op-pair (alloc/free site) is named in the schema.
- *Design rule* (for every new field/kind): "will `propagate`/`checkDirty`/
  `link`/`notify` read it while walking? then it must be reachable as
  `M[id + K]` without leaving the plane. Touched only at leaves or
  boundaries? GC column keyed off the id." This is the rule that survives
  adding a node kind, because it's a question about the *algorithm*, not
  about the field's type.
- *The real mechanism/policy boundary is the existing `Engine` interface,
  one level up from where the substrate proposal wants it.* The engine is
  mechanism: it owns ids, layout, alien semantics, and reports **facts**
  upward (`write()` returns "this changed and had subscribers"; `gen(id)`
  reports liveness). The wrapper layer is policy: it decides to flush
  (`if (E.write(id, v) && !batchDepth) flush()`), owns batching, owns handle
  representation, and will own React scheduling and FinalizationRegistry
  reclamation. This split is already policy/mechanism-clean in the Unix
  sense — the engine never reads scheduler state to decide *whether* work
  should happen, only *what* is dirty. Guard it: concurrent-React features
  (priority lanes, transitions) must land as wrapper policy plus at most
  new engine *facts* (e.g. an epoch field), never as engine branches named
  after React concepts.

### 2.5 New-node-kind drill (does the cut survive?)

Adding a `watcher` kind (React's `useSyncExternalStore` subscriber) under
the recommended rules: (1) capability test — it participates in `notify`
walks → needs FLAGS + SUBS-side topology in-plane; its callback is a leaf →
`fns` column; (2) schema change — one new kind bit, no new fields (fits the
node record's spare fields 6–7 if it ever needs one); (3) codegen re-emits
the const enum + updated verifier; (4) all policy (when watchers fire
relative to effects) lands in the wrapper. Under the substrate split, steps
1–3 would *also* all happen — plus a substrate schema registration — because
the substrate owns nothing that changes. The extra layer pays rent only in
ceremony. Under pure capability-with-no-lifetime-rule, step 1 requires
profiling before a schema can be written; the lifetime rule gives the
default answer immediately and profiling only ever *promotes* fields into
the plane.

## 3. Precedents for bytes-layer/policy-layer splits (Q3)

## 4. Recommendations for arena/cosignal

## Sources
