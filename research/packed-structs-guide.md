# Packed structs in JS/TS: implementation and maintenance guide

Strategy for writing and **maintaining** data-oriented packed data structures
(struct-in-Int32Array / byte-plane style) in JavaScript/TypeScript over the long
term. Written for cosignal-arena; grounded in this repo's measured kernel
(`libs/arena/src/index.ts`, 179/179 conformance, ≤1.0× vs alien-signals on all
tier-0 shapes) and in RESEARCH.md §7/7a/7b. Companion docs:
`packed-authoring-practices.md` (authoring practices + layer-split analysis;
its §0 toolchain facts are cited as [PAP §0] below) and
`specs/cosignal-arena-b-versioned-core.md`.

Status: complete (2026-07-03). Web-sourced claims were gathered by three
research passes on this date; local claims cite RESEARCH.md / PAP sections
with measurements reproduced in this repo.

---

## 0. TL;DR recommendation

For cosignal-arena (and any successor packed-record engine):

1. **Do not adopt any existing JS struct library for the hot path.** Every
   surveyed tool (structurae, buffer-backed-object, typed-struct, restructure,
   capnp/flatbuffers runtimes, …) reads fields through DataView calls, class
   getters, or Proxies — none compiles down to the only acceptable form,
   `M[id + LITERAL]`, and none supports our interleaved stride-8/pre-multiplied-id
   layout as a first-class concept. They remain useful as *design references*
   and, at most, as serialization/tooling deps. (Survey: §2.)
2. **Constants: same-file `const enum` is the primary strategy** (now that the
   target project accepts a compile step). It is the proven fix — members
   inline as numeric literals under esbuild (transform AND bundle), tsx,
   vitest, and tsc alike [PAP §0.1]. The guide states each approach's
   toolchain demands explicitly (§3.4): `const enum` requires full TS
   compilation and dies under stripping-only pipelines (ts-blank-space,
   `tsc --erasableSyntaxOnly`, SWC/esbuild "strip types" mode); the fallback
   for such consumers is codegen'd literal constants emitted into the same
   file — which is what the generator produces anyway.
3. **Adopt a tiny in-repo schema→codegen step** (~300–500 lines, no deps):
   a TS file *is* the schema (records, fields, widths, doc comments, flag
   bits); a generator emits (a) the `const enum` layout block **into a marked
   generated region of the engine file itself** (cross-module constants do
   not reliably inline [PAP §0.1]), (b) a parallel debug module with checked
   accessors + invariant sweeper + hydrator, (c) a docs table. Generated code
   is checked in; a CI test regenerates and diffs. This is the pattern every
   mature precedent converges on (protobuf/flatc/Torque/Relay: §3).
4. **Never wrap hot-path field access in accessors.** The hot idiom stays
   raw `M[id + C.FIELD]`. Accessors exist only in the debug twin and in
   tooling. This is a measured wall, not a style preference: typed-array
   access is ~3 bytecodes vs 1 for a named property, V8 stops inlining at
   ~460 bytecodes (`link()` at 475 never inlined; splitting it won −8–13%),
   and dead `if (DEBUG)` guards cost ~10× function-size budget unless
   stripped by build-time `define` [RESEARCH §7b; PAP §0.2–0.3].
5. **Type-brand the integers.** `NodeId`/`LinkId` as branded `number`s catch
   id-kind confusion, un-premultiplied indices, and raw-plane-load-to-id
   assignment at compile time, with zero emitted JS [PAP §0.4].
6. **Policy over mechanism via the four precedent patterns** (§4): user-facing
   closures/objects are *handles* over integer ids; kind bits in the flags
   word give branch-dispatch on data already loaded; per-kind entry points
   keep V8 feedback monomorphic; the engine interface stays capability-narrow
   (facts up, commands down — never scheduler state down into the kernel).
7. **Visibility is a build-out, not an afterthought** (§5): DevTools custom
   formatter + `util.inspect.custom` hydrating a record id lazily; a
   `dumpGraph`/`toDot` snapshot module; an `verifyArena()` invariant sweeper
   run after every conformance case in debug builds; fast-check model-based
   tests driving packed vs reference implementations in lockstep.
8. **Schema changes are versioned rebuilds, not in-place patches** (§6):
   adding a field = bump `LAYOUT_VERSION`, regenerate, re-stride or claim a
   spare slot; the arena is in-memory-only so "migration" means closure
   rebuild + copy loop, exactly the machinery growth already uses.

---

## 1. The walls: measured constraints any tooling must respect

All from this repo's measurements (RESEARCH.md §7b, PAP §0), reproduced on
Node 24 / V8 13.x, esbuild 0.28.1, TS 6.0.3:

| # | Constraint | Evidence | Consequence for tooling |
|---|---|---|---|
| 1 | V8 inlining budget ~460 bytecodes/function (`--max-inlined-bytecode-size`), 27 for "small function" greedy inlining, 920 cumulative per optimized function. Typed-array field access ≈3 bytecodes vs 1 for object field. | `link()` at 475 bytecodes hit `kExceedsBytecodeLimit`, never inlined into read paths; fast-path split → deep −8%, broad −10%, diamond −13% | Abstraction layers that expand accessor bytecode are poison. Accessors must compile away entirely (be absent from emitted hot code), not merely "be small". |
| 2 | Constants must survive packaging. esbuild bundling demotes module-scope `const` to mutable `var` → TurboFan loses constant folding: +15–21% kairo. Cross-file `const enum` inlines under esbuild *bundle* but NOT esbuild *transform* (tsx/vitest per-file) or `tsc --isolatedModules`. | RESEARCH §7b; PAP §0.1 [verified locally] | Layout constants and hot code must live in the **same file**; same-file `const enum` inlines everywhere. Codegen must emit into the engine file, not a sibling module. |
| 3 | Buffers behind `const` closure bindings; growth by closure rebuild at op boundaries only. Rejected by measurement: segment tables (+35–40%/access), resizable ArrayBuffers (+66–83% traversal), mutable `let` bindings (+34–43%), per-function aliases (+26–30%). | v8-growable-buffer-bindings note; RESEARCH §7 | Any tool that owns the buffer must expose "rebuild the world over a bigger buffer" as the growth protocol; anything that reads through a mutable binding or a proxy is out. |
| 4 | Monomorphic access sites. Type variety through shared closures measurably degrades the JIT; one hidden class per plane; never type-segregate the value column. | RESEARCH §7 (spike findings); arena-links post-mortem | No generic `read(buffer, schema, field)` entry points shared across record kinds. Per-kind entry points; shared code only where the *data* is uniform (the Int32 plane). |
| 5 | Record interleaving (AoS in one plane, stride 8) beats parallel SoA columns for graph traversal; ids are pre-multiplied byte-element offsets (`id = record*8`), so field access is one add. | spike: parallel columns 1.8× worse on deep chains; plane merge −2%/−8% | Schema/codegen must model *interleaved records sharing a plane* and *pre-multiplied ids* natively — most ECS/struct tools assume SoA or per-struct buffers and cannot express this. |
| 6 | Debug checks must strip via build-time `define`, not runtime consts. `if (false)` folds at bytecode-gen (14 bytecodes, identical to unguarded); `const DEV=false` guard leaves 148 bytecodes of dead check. | PAP §0.3 [verified locally] | Debug/assert variants are a *parallel build artifact* (twin module or `define`-guarded blocks), never a runtime flag on the hot function. |
| 7 | Bounds-check masking is a non-fix: `& MASK` on every access was noise-to-harmful (+21% creation). Typed-array bounds checks are effectively free on data-dependent walks. | libs/arena-masked, RESEARCH §7b | Don't let tooling emit "clever" masked access; emit the plain load. |

Anything below that contradicts these walls is wrong no matter whose blog it
came from.

---

## 2. Tool survey: existing JS packed/binary-struct libraries

**Headline finding: no existing library emits the target pattern** (offsets
as compile-time literals + raw `M[id + OFF]` typed-array loads). Every
surveyed tool falls into one of three buckets: (a) getter/DataView runtime
interpretation, (b) decode-to-plain-object parsers, (c) no accessor layer at
all — the library hands you typed arrays and user code writes raw index math
(the ECS family). Only bucket (c) satisfies walls 1–4, and it is a
*convention*, not an abstraction — which validates rolling our own
constants/codegen approach rather than adopting a dependency.

### 2.1 Verdict table

Wall numbers refer to §1. "Tooling ✓" = usable for debug views,
serialization, or snapshot formats over the same buffer.

| Tool | Field-read mechanism | Hot path | Tooling | Status |
|---|---|---|---|---|
| [structurae](https://github.com/zandaqo/structurae) | `DataView` subclass; runtime `layout[field]` lookup → virtual `View.decode` | ✗ walls 1,3,4 | ✓ (JSON-Schema layouts; old `RecordArray` was interleaved AoS) | quiet since v4 |
| [bitECS v0.3](https://www.npmjs.com/package/bitecs/v/0.3.11) | raw `Position.x[eid]` on lib-allocated SoA typed arrays | ✓ but SoA-only (wall 5 unmet) | n/a | superseded |
| [bitECS v0.4](https://github.com/NateTheGreatt/bitECS) | none — storage removed, bring-your-own store | ✓ by absence (convention prior art) | n/a | active |
| [buffer-backed-object](https://github.com/GoogleChromeLabs/buffer-backed-object) | per-field `defineProperty` closures over DataView + Proxy array | ✗ walls 1,3,4 (every disqualifier at once) | ✓ AoS lazy debug views | dormant (2020) |
| [typed-struct](https://github.com/sarakusha/typed-struct) | class getters/setters deserializing from Buffer per access | ✗ walls 1,4 | ✓ protocols | active |
| [struct-fu](https://github.com/natevw/struct-fu) | whole-buffer pack/unpack → plain objects | ✗ serializer | ~ | abandoned (2018) |
| [restructure](https://github.com/foliojs/restructure) | runtime schema interpretation → plain objects (lazy option) | ✗ decode-then-use | ✓ parsers | maintained for fontkit |
| [binary-parser](https://github.com/keichi/binary-parser) | **runtime codegen** (`new Function`, `getCode()`) → plain objects | ✗ decode-then-use | ✓✓ best codegen precedent | active |
| [capnp-ts](https://github.com/jdiaz5513/capnp-ts) | generated getters → bounds check + pointer resolve + segment DataView | ✗ walls 1,4 | ~ | unmaintained (2021) |
| [capnp-es](https://github.com/unjs/capnp-es) | generated `get x()` → `$.utils.getUint32` → DataView | ✗ walls 1,4 | ✓ | active, alpha |
| [FlatBuffers TS](https://flatbuffers.dev/languages/typescript/) | generated method: vtable `__offset` + Uint8Array byte assembly | ✗ wall 1 (see anatomy below) | ✓✓ snapshots/interchange | very active |
| [bun:ffi `read.*`](https://bun.com/docs/api/ffi) | native-pointer reads (JSC) | n/a — not V8, no struct layout helpers, experimental | ~ | experimental |
| [Kaitai Struct JS](https://github.com/kaitai-io/kaitai_struct_javascript_runtime) | DataView stream, eager decode-to-object | ✗ | ✓ format debugging | stable |
| [typed-binary](https://github.com/iwoplaza/typed-binary) | BufferReader runtime interpretation | ✗ | ✓ serializer | active |
| [@bnaya/objectbuffer](https://github.com/Bnaya/objectbuffer) | Proxy object-heap over ArrayBuffer (README: won't "make your code run faster") | ✗ walls 1,3 | ~ shared-memory niche | 2024 |
| [wolf-ecs / piecs](https://github.com/EnderShadow8/wolf-ecs) | raw SoA index math (bitECS-style) | ✓ SoA-only | n/a | tops [ecs-benchmark](https://github.com/noctjs/ecs-benchmark) |

Footnote: [TC39 `proposal-structs`](https://github.com/tc39/proposal-structs)
(fixed-layout objects at the language level) is the eventual "real" fix;
until it ships and JITs prove out, the plane idiom stands.

### 2.2 Anatomy of why the accessor libraries lose

Two dissections worth keeping (both from generated/library source):

- **capnp-ts "safe accessor" cost**: `getId()` → `__S.getUint64(0, this)` →
  `checkDataBounds` + `getDataSection` (pointer resolution) + segment
  DataView read. Three calls, a bounds check, and a DataView op per field —
  vs our 1 add + 1 typed-array load. This is what "runtime interpretation"
  costs even with offsets as literals in generated code.
- **FlatBuffers table read**: `hp()` = vtable lookup (`__offset` — two
  dependent loads) + branch + `readInt16` assembled from `Uint8Array` bytes
  (4 loads, 3 shifts, 3 ORs behind two method calls). The vtable exists only
  for *on-disk evolvability*; an in-memory rebuildable plane needs none of
  it. (FlatBuffers' own fixed-layout "structs" read at `bb_pos + literal` —
  the direct analog of our layout — but still through method + byte
  assembly.) One reusable trick from
  [byte-buffer.ts](https://github.com/google/flatbuffers/blob/master/ts/byte-buffer.ts):
  float↔int reinterpretation via a shared aliased
  Int32Array/Float32Array scratch pair — relevant if a float field ever
  needs to live in the i32 plane.

Meanwhile the ECS family (bitECS, wolf-ecs, piecs) wins benchmarks precisely
by having **no layer**: library-allocated (or user-owned) typed arrays, raw
index math at every access site. bitECS v0.4 going storage-agnostic —
deleting `defineComponent` — is the ecosystem's own conclusion that the
storage abstraction was the least valuable layer to own [also PAP §2.2].
None of them support interleaved AoS records (wall 5), so they solve a
strictly easier constants problem (per-field arrays have no offsets). Our
interleaved layout is exactly the representation where offsets exist and
must be baked as literals by *something* — hence §3.

---

## 3. Schema-driven codegen strategy

Precedents for generating flat accessor code — offsets baked as literals —
from a schema at build time, and what they teach about maintenance.

### 3.1 Precedents

**mapbox/pbf — the target style.** A one-file, template-string compiler
(`pbf <proto>` → [compile.js](https://github.com/mapbox/pbf/blob/main/compile.js))
emits standalone read/write functions per message with field tags
interpolated as **numeric literals** (`if (field === 1) …`,
`pbf.writeVarintField(1, obj.name)`): flat, branchy, JIT-friendly, zero
runtime schema, and the README treats output as *readable source meant to be
customized*. Proof that a dependency-free string-concat generator is enough.

**FlatBuffers `flatc --ts`.** Generated accessors bake vtable slot literals
and defaults into the code
(`const offset = this.bb!.__offset(this.bb_pos, 6); return offset ? this.bb!.readInt16(this.bb_pos + offset) : 150;`
— [generated monster.ts](https://github.com/google/flatbuffers/blob/master/tests/ts/my-game/example/monster.ts)).
Instructive negative: the `__offset` vtable hop exists only for *on-disk
evolvable* tables; FlatBuffers "structs" (fixed layout, no vtable, cannot
evolve) are the direct-`M[id + OFF]` analog. In-memory planes want struct
semantics + a version constant, never table semantics.

**capnp-es.** Generated TS carries a schema-identity constant
(`export const _capnpFileId = 0x…n`), native getters with word offsets as
literals (`get id() { return $.utils.getUint32(0, this); }`), and **JSDoc
from the schema copied onto every accessor**
([fixture](https://github.com/unjs/capnp-es/blob/main/test/fixtures/serialization-demo.ts)).
Cap'n Proto's [evolution rules](https://capnproto.org/language.html) are the
cleanest statement of layout identity: *ordinal = identity, offset = derived*;
append-only; never change an existing member's number/type.

**protobuf spectrum.** google-protobuf JS emits literal-field-number getters
over a generic runtime helper (`jspb.Message.getFieldWithDefault(this, 1, 0)`)
— inlineable but one indirection; protobuf-es generates *no accessors at all*
(schema-as-data + runtime interpretation — the anti-pattern for hot paths,
though its generated-file hygiene is exemplary: plugin version recorded in the
header for reproducible builds); protobuf.js does **runtime** `new Function`
codegen with literal field ids — evidence that literal-baking wins even done
at runtime, but runtime eval loses debuggability/CSP and is unnecessary for us.

**V8 Torque — the in-engine analogy.** `.tq` class definitions generate C++
accessors, `kFieldOffset` constants, verifiers, and printers
([manual](https://v8.dev/docs/torque)). The sync mechanism is the lesson:
handwritten `JSProxy` inherits `TorqueGeneratedJSProxy<JSProxy, JSReceiver>`
(CRTP seam), so layout has exactly one source of truth; even classes that
opt out of generated accessors (`@doNotGenerateCppClass`) still consume
generated offset macros — **offsets are never handwritten, anywhere**. One
schema feeds multiple consumers (C++, CSA builtins, debug verifiers/printers)
— exactly our release/debug twin split.

**Rust zerocopy/bytemuck.** `#[derive(FromBytes, IntoBytes)]` only compiles
if the derive can *prove* layout soundness (repr pinned, padding explicit)
([docs](https://docs.rs/zerocopy/latest/zerocopy/trait.FromBytes.html)).
Lesson: **the generator refuses to emit for a layout it can't prove** —
slots unique, `< stride`, spares named, masks disjoint — and layout
guarantees are declared on the type (`repr(C)` ≈ our `stride: 8`), not
implied by generator behavior.

**Game-engine seams.** Unity DOTS source generators emit the other half of a
user's `partial struct` into `.g.cs` files — handwritten and generated code
are separate files of one type, neither edits the other
([docs](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/aspects-source-generation.html)).
Unreal's UHT splices generated declarations into a handwritten class at the
`GENERATED_BODY()` marker and derives member offsets from the real compiler
rather than reverse-engineering packing
([UHT docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-header-tool-for-unreal-engine))
— drift-proofing: one authority for offsets, verified against reality.

**Checked-in JS codegen conventions.** Relay: `__generated__/` directories,
`@generated SignedSource<<hash>>` headers so CI detects hand-edits/staleness;
graphql-codegen: `/* eslint-disable */` + "DO NOT EDIT — run `yarn
graphql:codegen`" headers ([add plugin](https://the-guild.dev/graphql/codegen/plugins/other/add)).
Lesson: the header names the regeneration command and carries a
machine-checkable hash.

**bitECS — the instructive counter-example.** v0.3's runtime
`defineComponent({x: Types.f32})` was *removed* in v0.4; components are now
plain hand-written SoA objects (`Position.x[eid]`)
([release notes](https://github.com/NateTheGreatt/bitECS/blob/main/docs/RELEASE_NOTES_0.4.0.md)).
bitECS never needed codegen because per-field parallel arrays have no offset
arithmetic. Our interleaved-stride layout (which beats parallel arrays for
graph traversal, §1 wall 5) is precisely the representation where offsets
exist — and therefore must be baked as literals by *something*: hand
discipline today, a generator at scale.

### 3.2 The minimal codegen playbook (synthesis)

What the precedents converge on, adapted to our walls:

1. **Schema is data, in one file, in the host language.** Nothing else may
   state an offset; release constants, debug accessors, docs, verifiers, and
   snapshot headers all derive from it. Explicit slot numbers are identity
   (Cap'n Proto ordinals, FlatBuffers `id`); source order is cosmetic.
2. **Emit literals, not lookups.** The schema object must be unreachable
   from the hot path — the engine file does not import it; the generator
   interpolates numbers into source (pbf/flatc/jspb/Torque all do this).
3. **Seam pattern, adjusted for JS bundling.** V8/Unity use import/CRTP/
   partial-class seams because C++/C# resolve cross-unit constants for free.
   JS bundlers don't (§1 wall 2), so for *constants* the right seam is UHT's:
   a marked generated region **spliced into the handwritten engine file**
   (`GENERATED_BODY()` analog). Whole-file generation for everything whose
   cross-module cost doesn't matter (debug twin, docs, formatters).
4. **Check artifacts in, with self-describing headers** naming the regen
   command + schema hash (Relay SignedSource style).
5. **Deterministic, idempotent emit; drift enforced in CI** by
   regenerate-and-string-compare (JS-equivalent of `flatc --conform` +
   Relay signed-source validation). The same step validates the schema and
   refuses unprovable layouts (zerocopy move).
6. **Debug variant generated from the same schema, never branched inside
   release accessors.** Torque generates accessors *and* verifiers *and*
   printers from one schema; our generator emits the hot `const enum` and
   the checked debug twin from one schema. Debug asserts strip via esbuild
   `define` (§1 wall 6).
7. **Carry doc comments from schema to every emitted member** (capnp-es,
   Torque) so readers never open the schema to understand a call site.
8. **Version the layout; append, deprecate, never renumber** (Cap'n Proto /
   FlatBuffers / SQLite ADD-COLUMN rules; §6.2). New fields need constant
   defaults so migration is `fill()`-or-nothing; mismatched snapshot load
   without a migration is a hard error.
9. **Keep the generator boring.** pbf's whole compiler is one file of
   template strings; no ts-morph/ts-poet needed at this scale. No runtime
   `new Function` codegen — it forfeits debuggability and buys nothing at
   build time.
10. **Give tooling a foothold**: `*.generated.*` / `__generated__/` naming so
    lint/coverage/review exclude generated code wholesale, and grep for
    "who states offsets" returns exactly two files: schema + artifact.

### 3.3 What the generator must emit for us

(see §7 for the concrete cosignal-arena sketch: same-file `const enum`
region, debug twin module, docs table, regen-diff fixture)

### 3.4 Constant-inlining strategies and the toolchain each imposes

| Strategy | Inlines as literal under… | Fails under… | Toolchain demand |
|---|---|---|---|
| Same-file `const enum` (**primary**) | esbuild transform+bundle, tsx, vitest, tsc, swc (compile mode) | ts-blank-space / type-stripping-only; `erasableSyntaxOnly`; `isolatedModules` warns for ambient cases | Requires a real TS compile step (tsdown/tsc/esbuild). Accepted by target project. |
| Codegen'd literal `const` inside function scope / literals inline in expressions | everything (they're literals in the source) | nothing | Requires the generator to macro-expand offsets into use sites or emit function-scope consts; more codegen surface. This is the stripping-only fallback. |
| Module-scope `const` | plain node ESM (unbundled) | esbuild bundling (demoted to `var`) → +15–21% | None, but packaging-fragile: forbidden. |
| Cross-module `const enum` import | esbuild bundle mode only | esbuild transform (tsx/vitest), tsc isolatedModules | Forbidden: packaging-dependent [PAP §0.1]. |
| `define`-injected constants (`--define:OFF_FLAGS=0`) | any esbuild pipeline | non-esbuild consumers; noisy config | Viable for DEBUG flag only; wrong tool for dozens of offsets. |

---

## 4. Polymorphic policy over a monomorphic core: the recurring patterns

How mature systems mesh a dynamic policy layer over packed cores — surveyed
across game ECS, databases, VMs, column stores, and OS kernels. The same
four patterns recur everywhere; each is stated below as a rule for a JS
reactivity engine whose user-facing closures wrap integer record ids.

Precedent base (details/links in Sources):

- **Game ECS**: flecs entities are 64-bit integer ids; same-component-set
  entities share an archetype table (SoA); systems run an outer loop over
  tables (where kind variance is resolved) and a monomorphic inner loop over
  packed columns ([flecs Quickstart/Systems manual](https://www.flecs.dev/flecs/md_docs_2Systems.html)).
  Bevy's [`Table`](https://docs.rs/bevy/latest/bevy/ecs/storage/struct.Table.html)
  is documented "column-oriented structure-of-arrays" — row *i* across columns
  is one entity. Fabian's *Data-Oriented Design*
  ([existence-based processing](https://www.dataorienteddesign.com/dodmain/node4.html))
  supplies the doctrine: membership in a table replaces per-object boolean
  branches — process the whole table unconditionally.
- **Databases**: SQLite compiles arbitrary SQL (policy) to
  [VDBE bytecode](https://www.sqlite.org/opcode.html) run by a small fixed
  engine over a rigid packed [record format](https://www.sqlite.org/fileformat2.html)
  ([architecture doc](https://sqlite.org/arch.html)) — infinite policy
  variety, one mechanism. DuckDB's
  [vector internals](https://duckdb.org/docs/stable/internals/vector) add
  `UnifiedVectorFormat`: one canonical view (data pointer + selection
  indices) so generic operators avoid the combinatorial explosion of
  specialized code, while hot operators still specialize. LMDB exposes one
  memory-mapped page store through a tiny cursor API — the cursor is the
  only mutable/polymorphic thing ([lmdb.tech/doc](http://www.lmdb.tech/doc/)).
- **V8 itself**: all heap access goes through `Local<T>` handles — pointers
  to slots, not objects — so the moving GC can relocate freely
  ([embedding guide](https://v8.dev/docs/embed)); hidden classes hoist the
  name→offset shape out of instances into a shared descriptor, and inline
  caches key on the map pointer so access is "compare kind once, load fixed
  offset" ([Fast properties](https://v8.dev/blog/fast-properties)).
- **Erlang/BEAM**: every term is one tagged machine word (2 low bits primary
  tag, staged sub-tags) under a uniform term API
  ([The BEAM Book](https://blog.stenmans.org/theBeamBook/)) — legitimizing
  kind bits packed into the word you already loaded (or into the id itself).
- **Column stores**: Arrow compute
  [dispatches a type signature to one specialized kernel](https://arrow.apache.org/docs/cpp/compute.html)
  ("selecting a viable kernel … is referred to as 'dispatching'") whose inner
  loop is monomorphic; Velox's expression evaluator *peels* dictionary
  encodings before the loop so the loop body never sees representation
  variety ([Velox vectors](https://facebookincubator.github.io/velox/develop/vectors.html)).
- **OS kernels**: the fd is THE handle precedent — integer index into a
  per-process table mapping to `struct file`, whose per-kind
  `file_operations` vtable is bound **once at open()**, not per syscall
  ([Linux VFS docs](https://docs.kernel.org/filesystems/vfs.html)).

### 4.1 The four rules

1. **Handles are opaque integer ids + an indirection layer; never leak
   addresses.** (fds, `Local<T>`, entity ids.) The closure from `signal()`
   captures only a record id; every access recomputes against the *current*
   plane binding, so the store can grow (closure rebuild) or recycle
   (free list) underneath. Recycled slots get a generation counter checked
   by disposers — the moral equivalent of V8 rewriting handle slots on GC
   moves, or slotmap keys. `libs/arena` already does exactly this (`C.GEN`).
2. **Bind kind-dispatch once at handle creation; keep hot kernels
   branch-poor.** (file→f_op at open; Arrow DispatchExact; hidden-class ICs.)
   `signal()` closes over the signal-specialized read/write entry points,
   `computed()` over computed's — each call site stays monomorphic in V8's
   feedback. Inside walk kernels, kind tests are single bit-tests on a flags
   word the walk already loaded — a dispatch on data, never virtual methods
   or a side lookup.
3. **Policy is data interpreted by one small fixed kernel; mechanism is the
   packed layout.** (VDBE bytecode over B-tree cells; systems over component
   columns.) Feature variety — equality options, scheduling, liveness,
   priority lanes — must compile down to flag bits / side-table indices that
   the one propagation kernel consumes. Resist a second record layout per
   feature: uniform stride with occasionally-unused (spare) fields beats
   variable layout, exactly as SQLite runs every query through one cell
   format. Corollary for cosignal: React concepts arrive as small integers
   (version/lane ids) selecting kernel behavior, never as kernel branches
   named after React.
4. **One canonical view for generic code; peeled fast paths for hot code.**
   (DuckDB `UnifiedVectorFormat`; Velox dictionary peeling.) Provide a
   single debug/tooling accessor layer (`hydrateNode(id)`, `nodeFlags(M,id)`)
   that formatters, verifiers, dumpers, and tests all share — and let hot
   paths bypass it entirely with raw `M[id + C.X]`. The unified view is
   *cold-path* infrastructure; its existence is what makes §5's tooling
   cheap (write the decoder once; everything else is a thin layer over it).

### 4.2 How the arena kernel already embodies them

- **Handle indirection**: `signal()` returns a closure over an integer `id`;
  the user never sees the plane. Generation counters (`C.GEN`) make stale
  handles safe — the same trick as fd generations / slotmap keys.
- **Kind dispatch on loaded data**: kind bits live in the same flags word as
  the state machine bits, so `update()` dispatch is a bit test on a word the
  walk already loaded — no side table, no polymorphic map lookup.
- **Per-kind entry points**: `read` (signal) vs `computedRead` vs `run`
  (effect) are separate functions with separate feedback slots; the public
  wrappers keep call sites monomorphic per kind.
- **Capability-narrow interface**: the `Engine` record reports facts
  (`write() → "changed & had subs"`, `gen(id)`) and never reads scheduler
  state; flush/batch/React policy lives in the wrapper [PAP §2.4].

---

## 5. Developer visibility: living with bytes

The packed representation trades away every default affordance of JS objects
— `console.log`, heap-snapshot attribution, debugger hover — so visibility
must be *built*, and cheaply. The key economy: **all five tools below share
one substrate** — a debug-only "decode record id → plain object" module
(§4.1 rule 4, the generated debug twin of §7.2). Write the decoder once; the
formatter, verifier, DOT dumper, inspector hook, and model-test comparator
are thin layers over it.

### 5.1 Lazy hydration: record id → inspectable object

- **Chrome DevTools custom object formatters**: a page/process-global
  `devtoolsFormatters` array of `{header, hasBody, body}` objects returning
  JsonML; opt-in via DevTools Settings → Console → "Enable custom
  formatters". Canonical spec is the DevTools team's
  [Custom Object Formatters doc](https://docs.google.com/document/d/1FTascZXT9cxfetuPRT2eXPQKXui4nWFivUnS_335T3U/preview);
  good tutorials by [Zeunert](https://www.mattzeunert.com/2016/02/19/custom-chrome-devtools-object-formatters.html)
  and [devtoolstips.org](https://devtoolstips.org/tips/en/custom-object-formatters/);
  shipping-library precedents:
  [immutable-devtools](https://github.com/andrewdavey/immutable-devtools),
  [jsdom-devtools-formatter](https://github.com/jsdom/jsdom-devtools-formatter).
  Firefox [supports the same API](https://firefox-source-docs.mozilla.org/devtools-user/custom_formatters/index.html).
  Works in Node via `--inspect` + dedicated DevTools (the formatter runs in
  the inspected context). For us: a handle closure wrapping id 42 logs as
  useless `ƒ ()`; the formatter detects the handle brand (a symbol-keyed
  property on the closure carrying the id), reads the live plane, and
  renders `Signal(#42 v=7 DIRTY|K_SIGNAL subs:3)` with an expandable body of
  decoded deps/subs as further clickable handles. **Hydration is lazy by
  construction** — `header` decodes one record; `body` decodes neighbors
  only when expanded. Ship as opt-in dev import (`installFormatters()`).
- **Terminal twin**: [`util.inspect.custom`](https://nodejs.org/api/util.html#utilinspectcustom)
  on the same handles so plain Node `console.log` shows the identical
  decode. Cost when unused: one extra symbol property per handle in dev
  builds; zero in prod (installer is a no-op unless `__ARENA_DEBUG__`).

### 5.2 Snapshot/dump utilities (dumpGraph / toDot)

Precedent in-house: `specs/cosignal-arena-b-versioned-core.md` §4.3 already
commits to `dependencyGraphToDot(roots)` + `traceToDot(events)` in a lazy
`cosignal/graphviz` module that imports only types from tracing.

External precedents for "dump internal graph as DOT/JSON, view offline":
V8's `--trace-turbo` + [Turbolizer](https://v8.github.io/tools/head/turbolizer/),
rustc's [`-Z dump-mir-graphviz`](https://rustc-dev-guide.rust-lang.org/mir/debugging.html),
GStreamer's [`GST_DEBUG_BIN_TO_DOT_FILE`](https://gstreamer.freedesktop.org/documentation/gstreamer/debugutils.html).
The arena version is trivial over the decoder: iterate live records (kind
bits set), one DOT node per record (label = id/kind/flags/value preview,
color = dirty state), edges straight from the packed dep/sub lists.
**Diffing two dumps** is the workhorse for wiring bugs. Timeline tracing:
buffer [Trace Event Format](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview)
JSON from propagate/flush/update spans and open in
[Perfetto](https://perfetto.dev/docs/getting-started/other-formats) for
benchmark runs; in-browser, the
[DevTools Performance extensibility API](https://developer.chrome.com/docs/devtools/performance/extension)
(`console.timeStamp` — near-zero overhead when not recording) puts a custom
"reactivity" track next to real frame work.

### 5.3 Invariant checkers as debug builds

Two canonical precedents for "walk the packed structure, check everything":
V8's `--verify-heap` (full-heap verifier, debug-build gated, run at GC
boundaries) and SQLite's
[`PRAGMA integrity_check`](https://www.sqlite.org/pragma.html#pragma_integrity_check)
(walks every page/cell, **lists all problems rather than stopping at the
first**, with a cheaper `quick_check` tier).

`verifyArena()` for our plane (generated skeleton from the schema's field
`kind`s, §7.1, plus handwritten graph rules):

- allocation: every record is on a free list XOR has kind bits; free-list
  chains are acyclic, terminate at 0, and lie below the bump pointer;
  record 0 is all-zero (burned NULL);
- fields: `spare` slots read 0 on live records; `LinkId`/`NodeId` fields are
  0 or point at live records of the right role; ids are stride-aligned;
- graph: every link appears exactly once in its dep's subs list and its
  sub's deps list (prev/next coherence both directions; tails reachable
  from heads); `HAS_CHILD_EFFECT` implied by an actual non-signal/computed
  dep; exactly one kind bit set per live node;
- side columns: `values`/`fns` slots for freed records are `undefined`
  (no leaks past `freeNode`);
- scheduler coupling (the invariants that actually bite, [PAP §2.2]):
  queued ids have kind bits; `pendingFree` entries are kind-less; scratch
  stack pointers are at their bases at op boundaries.

Gating per V8's pattern: debug build only (`__ARENA_DEBUG__` define), run at
natural barriers — end of flush, end of batch, after every conformance case,
and inside every fast-check command step.

### 5.4 Testing strategy

Conformance-first (project method: 179-case reactive-framework-test-suite
before any number), then:

- **Model-based testing with fast-check**
  ([model-based docs](https://fast-check.dev/docs/advanced/model-based-testing/)):
  commands = createSignal / createComputed(random wiring) / write / read /
  dispose / batch; `run(model, real)` applies each to the reference engine
  (upstream alien-signals) and the packed engine, asserting observable
  equivalence (values, effect-run counts, pull counts). Shrinking yields the
  *minimal* graph + op sequence that desynchronizes the cores — strictly
  better than hand-written graph fixtures for the checkDirty subtleties that
  bit the spike (20% over-recompute, RESEARCH §7).
- plain `fc.property` roundtrips for the leaf mechanics: alloc/free/realloc
  cycles preserve free-list integrity; flag pack/unpack; id premultiply
  encode/decode; snapshot dump→load identity.
- debug-build invariant sweep after every conformance case (§5.3);
- **bytecode-budget regression test** (§6.4) — the automated `link()` lesson.

### 5.5 Heap snapshots and memory accounting

In Chrome/Node heap snapshots an ArrayBuffer's payload is a separate system
object (`JSArrayBufferData` backing store), not part of any user object's
shallow size ([memory docs](https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshots);
Chrome 123 added an experiment folding backing stores into containers).
This cuts both ways:

- **Upside**: graph memory becomes one legible number ("the graph is one
  4 MB buffer"); per-node GC pressure vanishes from snapshots — already
  observed as arena's −38% effects-memory win and the "heapUsed-invisible"
  arena note in memory.
- **Downside**: per-object accounting is gone *by construction* — snapshots
  can't say which records leak. Ship the replacement: a `stats()` dump
  (records allocated / free-list lengths / bump watermark / side-column
  fill / bytes per plane) and lean on `verifyArena` + generation counters
  for leak-hunting (e.g. count live records by kind and diff across a
  test). DevTools' [Memory Inspector](https://developer.chrome.com/docs/devtools/memory-inspector)
  gives a raw hex view of the live buffer when eyeballing is needed.

---

## 6. Migration & maintenance: schema changes over time

The load-bearing observation: our planes are **in-memory only**. There is no
on-disk compatibility problem; a "migration" is a code change plus, at most, a
copy loop at an operation boundary — the machinery growth already uses
(closure rebuild over new buffers). That collapses the hard parts of schema
evolution (FlatBuffers vtables, protobuf field numbers) into a much smaller
discipline. What remains is *source-level* maintenance: keeping constants,
debug tooling, docs, and invariant checks in sync as the layout changes.

### 6.1 What "adding a field" means in an in-memory plane

Ranked by cost; the schema should force the author to pick one explicitly:

1. **Claim a spare slot** (free). This is *why we pad*: node records use 6 of
   8 slots, links 7 of 8 (`libs/arena/src/index.ts` — "fields 6-7 spare (pad
   to one cache line per record)"). Spares must be *named* in the schema
   (`SPARE6`, `SPARE7`), so claiming one is a schema edit + regenerate, and
   the invariant sweeper always knew they must read 0 on live records
   (cheap corruption tripwire until claimed).
2. **Steal bits** from an existing word (free, riskier). The flags word holds
   alien's six semantic bits + four kind bits ≤ bit 10; a small counter or
   enum can pack above them. Schema owns the bit registry; the generator
   fails on overlap and re-emits masks.
3. **Add a side column** (cheap, off the walk). If the capability test says
   the walks never read it [PAP §2.3], it does not belong in the plane at
   all — add a packed side array indexed off the id (`values`/`fns`
   precedent). No re-stride, no plane change.
4. **Re-stride** (expensive, deliberate). Stride is part of id encoding
   (`id = record * stride`, pre-multiplied), so changing 8→16 changes what
   every id *means*. That is fine across a code change (arena is rebuilt at
   startup) but invalidates any persisted snapshot and every "magic number"
   in tests. Also a *performance* event: stride 8 × i32 = one 32-byte
   half-line per record; measure before/after on tier-0 shapes (plane-merge
   history shows layout deltas of ±2–13%). Re-stride requires bumping
   `LAYOUT_VERSION`.

Removing a field: rename the slot back to `SPAREn`, keep the numbering of the
other fields **stable** (renumbering is legal — rebuild-at-deploy — but it
churns every generated constant, invalidates snapshots, and makes
git-archaeology of perf regressions harder; renumber only on a deliberate
compaction pass that also bumps `LAYOUT_VERSION`).

### 6.2 Versioning discipline

- The schema file carries `layoutVersion: N` and the generator emits it as
  `C.LAYOUT_VERSION`. Any change to stride, field slots, flag bits, or side
  column addressing bumps it. Doc-comment-only edits do not.
- **Snapshots are stamped.** Any dump/snapshot format (debug dumps, SSR-ish
  state capture, test fixtures with raw plane contents) starts with
  `[MAGIC, LAYOUT_VERSION]`. Loaders refuse a mismatch by default.
- **Migration functions are opt-in, not automatic.** If a fixture or
  hot-reload path really must survive a layout change, the schema history
  (old layouts kept as data in the schema file) is enough to generate or
  hand-write `migrateSnapshot(old, fromVersion): Int32Array` — a per-record
  field-shuffle copy loop. Do not build this until something needs it; the
  version-stamp refusal is the deliverable.
- Handles do not survive migration. Ids are only meaningful against the
  plane that allocated them; a layout change is a world rebuild.

### 6.3 Keeping generated and handwritten code separated

Rules (precedents in §3; the constraint that forces the unusual part is #2 of
§1 — constants must be emitted *into* the engine file):

1. **Generated-region markers inside the engine file, whole-file generation
   everywhere else.** The engine file gets exactly one generated region — the
   layout `const enum` + version — bracketed by
   `// #region GENERATED — layout vN (from schema.ts; run pnpm gen) — DO NOT EDIT`
   / `// #endregion GENERATED`. All other artifacts (debug twin, formatter,
   docs table) are whole generated files with a `// @generated` first line.
   The generator only ever rewrites text between its own markers; a missing
   or duplicated marker is a hard error, never a guess.
2. **Generated code is checked in.** Reviews see layout changes as diffs of
   literals; consumers need no codegen step; the build cannot skew from the
   repo. (Relay/protobuf-es/GraphQL-codegen convention; §3.)
3. **Deterministic emit.** Sorted iteration, no timestamps, stable formatting
   (run the repo formatter over output), so regeneration is idempotent and
   the drift test (below) is a string equality.
4. **The generator never owns function structure.** It emits constants, leaf
   accessors (debug twin only), tables, and comments. Hot-function shape —
   fast-path splits like `link`/`linkInsert`, loop structure, try/finally
   placement — is handwritten and performance-reviewed; codegen touching it
   would put the §7b lessons behind a tool nobody profiles.

### 6.4 Drift detection

- **Regen-diff test in CI**: a unit test imports the schema, runs the
  generator in-memory, and string-compares against the checked-in regions.
  Failure message says `run pnpm gen`. This is the standard checked-in-codegen
  guard (Relay `--validate`, protobuf `buf generate` + git-diff CI; §3).
- **Schema self-checks at generate time**: field slots < stride and unique
  per record; flag bits disjoint; kind mask = union of kind bits; spare slots
  named; every field has a doc string and an owner note (which op writes it,
  which op clears it — the storage rule of [PAP §2.4]).
- **Bytecode-budget regression test**: run
  `node --print-bytecode --print-bytecode-filter=link,propagate,checkDirty,…`
  over a smoke script and assert each named hot function's bytecode count
  stays under its declared budget (e.g. `link ≤ 200`). This automates the
  `link()` 475-bytecode discovery [RESEARCH §7b] so a refactor can't silently
  push a hot function past inlining eligibility. Budgets live in the schema
  file next to the function names.
- **Invariant sweeper in debug CI**: conformance suite runs once in the debug
  build with `verifyArena()` after every case (§5.3).

---

---

## 7. Concrete recommendation for cosignal-arena

### 7.1 Schema DSL sketch (in-repo TS file)

The schema is a plain TS module exporting **data** (evaluated by the
generator with tsx; never imported by shipping code). No DSL framework —
object literals plus a `defineSchema()` that only validates and types:

```ts
// tools/schema.ts — the single source of truth for the arena layout
export const arena = defineSchema({
  layoutVersion: 1,
  plane: {
    name: 'M', element: 'i32', stride: 8,
    ids: 'premultiplied', // id = record * stride; record 0 burned as NULL
  },
  records: {
    node: {
      doc: 'Signal / computed / effect / scope. One per user primitive.',
      fields: {
        FLAGS:     { slot: 0, kind: 'flags',  doc: 'state machine + kind bits' },
        DEPS:      { slot: 1, kind: 'LinkId', doc: 'deps list head', freelistNext: true,
                     owner: 'link()/unlink(); freed records thread free list here' },
        DEPS_TAIL: { slot: 2, kind: 'LinkId', doc: 'deps list tail / re-track cursor' },
        SUBS:      { slot: 3, kind: 'LinkId', doc: 'subs list head' },
        SUBS_TAIL: { slot: 4, kind: 'LinkId', doc: 'subs list tail' },
        GEN:       { slot: 5, kind: 'u31',    doc: 'bumped on free; defuses stale disposers' },
        SPARE6:    { slot: 6, kind: 'spare' },
        SPARE7:    { slot: 7, kind: 'spare' },
      },
    },
    link: {
      doc: 'Dependency edge; shares the plane with nodes (single bump pointer).',
      fields: {
        VERSION:  { slot: 0, kind: 'u31',    doc: 'cycle stamp for re-track dedup' },
        DEP:      { slot: 1, kind: 'NodeId' },
        SUB:      { slot: 2, kind: 'NodeId' },
        PREV_SUB: { slot: 3, kind: 'LinkId' },
        NEXT_SUB: { slot: 4, kind: 'LinkId' },
        PREV_DEP: { slot: 5, kind: 'LinkId' },
        NEXT_DEP: { slot: 6, kind: 'LinkId', freelistNext: true },
        SPARE7:   { slot: 7, kind: 'spare' },
      },
    },
  },
  flags: {
    // value OR 'bit: n'; generator checks disjointness and emits masks
    MUTABLE: 1 << 0, WATCHING: 1 << 1, RECURSED_CHECK: 1 << 2,
    RECURSED: 1 << 3, DIRTY: 1 << 4, PENDING: 1 << 5, HAS_CHILD_EFFECT: 1 << 6,
    K_SIGNAL: 1 << 7, K_COMPUTED: 1 << 8, K_EFFECT: 1 << 9, K_SCOPE: 1 << 10,
  },
  masks: { KIND_MASK: ['K_SIGNAL', 'K_COMPUTED', 'K_EFFECT', 'K_SCOPE'] },
  sideColumns: {
    values: { index: 'id >> 2', slots: ['current', 'pendingOrCleanup'], type: 'unknown' },
    fns:    { index: 'id >> 3', slots: ['fn'], type: 'Function | undefined' },
  },
  constants: { REC_SLACK: 1280 },
  budgets: { // bytecode budgets enforced by the drift test (§6.4)
    link: 200, linkInsert: 460, propagate: 460, checkDirty: 460,
    read: 200, write: 200,
  },
})
```

`kind` strings do double duty: they pick the branded TS type in generated
debug accessors (`NodeId`/`LinkId` brands per [PAP §0.4]) and tell the
invariant sweeper what to check (a `LinkId` field must be 0 or a live link
record; a `spare` must be 0; `flags` must have exactly one kind bit set on
live nodes).

### 7.2 What the generator emits

One `tools/gen-layout.ts` (~300–500 lines, run via `pnpm gen`), four outputs:

1. **Layout region in `src/engine.ts`** (between markers; the only generated
   text in a handwritten file):

   ```ts
   // #region GENERATED — arena layout v1 (from tools/schema.ts; run `pnpm gen`) — DO NOT EDIT
   const enum C {
     /** node: state machine + kind bits */
     FLAGS = 0,
     /** node: deps list head (LinkId); free-list next when freed */
     DEPS = 1,
     // …every member carries its schema doc comment…
     STRIDE = 8,
     LAYOUT_VERSION = 1,
     REC_SLACK = 1280,
   }
   // #endregion GENERATED
   ```

   Same-file `const enum` is the primary strategy (§3.4). **Stripping-only
   fallback**: a generator flag macro-expands instead — rewrites `C.X`
   references in the engine file to literal numbers with a trailing
   `/* C.X */` comment (offsets stay literals under any toolchain, at the
   cost of noisier source). In practice the honest answer for consumers that
   cannot compile TS is "ship the compiled JS" — which tsdown produces
   anyway, with the enum already folded to literals.
2. **Debug twin `src/debug/layout.debug.ts`** (whole generated file; imports
   nothing from the engine): branded-type checked accessors
   (`nodeFlags(M, id: NodeId): number` with range/kind asserts), record
   hydrators (`hydrateNode(M, values, fns, id) → { kind, flags: string[],
   deps: LinkId[], … }`), `verifyArena()` (§5.3), and the field table as
   runtime data (`FIELDS_BY_RECORD`) for the DevTools formatter and dump
   tools. Cross-module cost is irrelevant here — none of it ships in the
   hot build.
3. **Docs table `docs/layout.md`**: one table per record (slot, name, type,
   owner, doc), the flags bit chart, side-column addressing. Generated so it
   cannot rot.
4. **Regen-diff fixture**: the test in §6.4 re-runs 1–3 in memory and diffs.

The debug *build* is selected by esbuild `define` (`__ARENA_DEBUG__`), so
hot-path assert blocks (`if (__ARENA_DEBUG__) assertLiveNode(id)`) cost
literally zero bytecodes when false [PAP §0.3], while the debug twin module
is only imported from tests/tooling.

### 7.3 Versioned migrations

Per §6.2: `LAYOUT_VERSION` in the enum; snapshots stamped and refused on
mismatch; schema history retained in `tools/schema.ts` as
`export const history = { 1: {...} }` when v2 lands; write
`migrateSnapshot` only when a real consumer (fixture corpus, hot-reload)
appears. Runtime data never migrates — the arena is rebuilt by (re)creating
the engine, and user handles never outlive the process.

### 7.4 Generated vs handwritten separation

Per §6.3. Concretely for cosignal-arena:

- `src/engine.ts` — handwritten hot code + one generated constants region.
- `src/debug/**`, `docs/layout.md` — fully generated, checked in.
- `tools/schema.ts`, `tools/gen-layout.ts` — handwritten, reviewed like code
  (schema edits are the *real* change; generated diffs are the echo).
- The generator never edits outside its markers, never reformats handwritten
  lines, and fails loudly if markers are absent/duplicated.

### 7.5 Escape hatches

1. **Raw plane access is the API, not a violation.** `M[id + C.FIELD]` is the
   sanctioned hot idiom; the generated accessors exist only in the debug twin
   and tooling. Nothing stops — or should stop — a handwritten fast path from
   reading fields the "wrong" way; the invariant sweeper + conformance suite
   are the guardrails, not encapsulation.
2. **`buffer()` on the engine** exposes the live plane for tests, probes, and
   the formatter (already present in `libs/arena`).
3. **Spare slots are pre-approved experiments**: a prototype can claim
   `SPARE6` locally without regenerating anything (it's already addressable);
   landing the experiment requires the schema edit + regen. This keeps
   iteration speed while forcing eventual bookkeeping.
4. **Budget overrides**: a hot function may declare a raised bytecode budget
   in the schema (`budgets`) with a comment justifying it (e.g. `linkInsert`
   is deliberately the never-inlined slow half of the split).
5. **Per-experiment layouts**: because everything flows from `tools/schema.ts`,
   an A/B layout experiment (e.g. stride 16, extra scheduling field) is a
   branch-local schema edit + regen — libs/arena-probe-style variants without
   hand-syncing constants across files.

---

## Sources

In-repo: `libs/arena/src/index.ts` (the proven kernel; header comment is the
growth/reclamation design record); `research/RESEARCH.md` §7/7a/7b (measured
constraints); `research/packed-authoring-practices.md` §0 (toolchain facts,
[verified locally] on esbuild 0.28.1 / TS 6.0.3 / Node 24) and §2 (layer-split
verdict); `research/specs/cosignal-arena-b-versioned-core.md` (target
project); `libs/arena-masked`, `libs/arena-links`, `libs/arena-probe`
(negative results and profiles cited in §1).

Tool survey (§2):
[structurae](https://github.com/zandaqo/structurae) ·
[bitECS](https://github.com/NateTheGreatt/bitECS) +
[v0.4 release notes](https://github.com/NateTheGreatt/bitECS/blob/main/docs/RELEASE_NOTES_0.4.0.md) ·
[buffer-backed-object](https://github.com/GoogleChromeLabs/buffer-backed-object) ·
[typed-struct](https://github.com/sarakusha/typed-struct) ·
[struct-fu](https://github.com/natevw/struct-fu) ·
[restructure](https://github.com/foliojs/restructure) ·
[binary-parser](https://github.com/keichi/binary-parser) ·
[capnp-ts struct.ts](https://github.com/jdiaz5513/capnp-ts/blob/master/packages/capnp-ts/src/serialization/pointers/struct.ts) ·
[capnp-es](https://github.com/unjs/capnp-es) ·
[FlatBuffers byte-buffer.ts](https://github.com/google/flatbuffers/blob/master/ts/byte-buffer.ts) +
[generated monster.ts](https://github.com/google/flatbuffers/blob/master/tests/ts/my-game/example/monster.ts) ·
[bun:ffi](https://bun.com/docs/api/ffi) ·
[Kaitai JS runtime](https://github.com/kaitai-io/kaitai_struct_javascript_runtime) ·
[typed-binary](https://github.com/iwoplaza/typed-binary) ·
[@bnaya/objectbuffer](https://github.com/Bnaya/objectbuffer) ·
[wolf-ecs](https://github.com/EnderShadow8/wolf-ecs) ·
[noctjs/ecs-benchmark](https://github.com/noctjs/ecs-benchmark) ·
[TC39 proposal-structs](https://github.com/tc39/proposal-structs)

Codegen precedents (§3, §6):
[mapbox/pbf](https://github.com/mapbox/pbf) +
[compile.js](https://github.com/mapbox/pbf/blob/main/compile.js) ·
[protobuf-es](https://github.com/bufbuild/protobuf-es) +
[2.0 blog](https://buf.build/blog/protobuf-es-v2) ·
[protobuf-javascript](https://github.com/protocolbuffers/protobuf-javascript) ·
[protobuf.js runtime codegen](https://github.com/protobufjs/protobuf.js/blob/master/README.md) ·
[FlatBuffers TS guide](https://flatbuffers.dev/languages/typescript/) +
[evolution rules](https://flatbuffers.dev/evolution/) ·
[Cap'n Proto language/evolution](https://capnproto.org/language.html) ·
[capnp-es generated fixture](https://github.com/unjs/capnp-es/blob/main/test/fixtures/serialization-demo.ts) ·
[V8 Torque manual](https://v8.dev/docs/torque) +
[Torque talk (Tebbi)](https://www.jfokus.se/jfokus20-preso/V8-Torque--A-Typed-Language-to-Implement-JavaScript.pdf) ·
[zerocopy FromBytes](https://docs.rs/zerocopy/latest/zerocopy/trait.FromBytes.html) +
[IntoBytes derive](https://google.github.io/zerocopy/zerocopy/derive.IntoBytes.html) ·
[Unity DOTS source generation](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/aspects-source-generation.html) ·
[Unreal UHT](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-header-tool-for-unreal-engine) ·
[Relay TS artifacts](https://github.com/relay-tools/relay-compiler-language-typescript) ·
[graphql-codegen add plugin](https://the-guild.dev/graphql/codegen/plugins/other/add) ·
[ts-poet](https://github.com/stephenh/ts-poet) ·
[Arrow IPC schema model](https://arrow.apache.org/docs/python/ipc.html) ·
[SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)

Policy-over-core precedents (§4):
[flecs Systems manual](https://www.flecs.dev/flecs/md_docs_2Systems.html) ·
[Bevy Table storage](https://docs.rs/bevy/latest/bevy/ecs/storage/struct.Table.html) ·
[Data-Oriented Design, existence-based processing](https://www.dataorienteddesign.com/dodmain/node4.html) ·
[SQLite architecture](https://sqlite.org/arch.html) +
[VDBE opcodes](https://www.sqlite.org/opcode.html) +
[record format](https://www.sqlite.org/fileformat2.html) ·
[DuckDB vector internals](https://duckdb.org/docs/stable/internals/vector) ·
[LMDB docs](http://www.lmdb.tech/doc/) ·
[V8 embedding guide (handles)](https://v8.dev/docs/embed) +
[Fast properties](https://v8.dev/blog/fast-properties) ·
[The BEAM Book](https://blog.stenmans.org/theBeamBook/) ·
[Arrow compute dispatch](https://arrow.apache.org/docs/cpp/compute.html) ·
[Velox vectors](https://facebookincubator.github.io/velox/develop/vectors.html) +
[expression evaluation](https://facebookincubator.github.io/velox/develop/expression-evaluation.html) ·
[Linux VFS](https://docs.kernel.org/filesystems/vfs.html) +
[fd tables](https://docs.kernel.org/filesystems/files.html)

Visibility (§5):
[Custom Object Formatters spec](https://docs.google.com/document/d/1FTascZXT9cxfetuPRT2eXPQKXui4nWFivUnS_335T3U/preview) ·
[Zeunert tutorial](https://www.mattzeunert.com/2016/02/19/custom-chrome-devtools-object-formatters.html) ·
[devtoolstips.org](https://devtoolstips.org/tips/en/custom-object-formatters/) ·
[immutable-devtools](https://github.com/andrewdavey/immutable-devtools) ·
[jsdom-devtools-formatter](https://github.com/jsdom/jsdom-devtools-formatter) ·
[Firefox custom formatters](https://firefox-source-docs.mozilla.org/devtools-user/custom_formatters/index.html) ·
[util.inspect.custom](https://nodejs.org/api/util.html#utilinspectcustom) ·
[heap snapshots](https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshots) ·
[Memory Inspector](https://developer.chrome.com/docs/devtools/memory-inspector) ·
[fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/) ·
[SQLite integrity_check](https://www.sqlite.org/pragma.html#pragma_integrity_check) ·
[Turbolizer](https://v8.github.io/tools/head/turbolizer/) ·
[rustc MIR graphviz dumps](https://rustc-dev-guide.rust-lang.org/mir/debugging.html) ·
[GStreamer DOT dumps](https://gstreamer.freedesktop.org/documentation/gstreamer/debugutils.html) ·
[Trace Event Format](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview) ·
[Perfetto](https://perfetto.dev/docs/getting-started/other-formats) ·
[DevTools Performance extensibility](https://developer.chrome.com/docs/devtools/performance/extension)
