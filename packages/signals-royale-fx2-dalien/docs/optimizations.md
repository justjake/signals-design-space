# How this engine got fast

This engine stores its reactive graph in typed arrays instead of JavaScript
objects. This document explains every optimization that took that design from
1.4x slower than an equivalent object-based engine to within ~6% on a standard
reactivity benchmark suite — while beating it outright on creation, on
update-heavy writes, and on every workload too large to fit in CPU cache. Each
section states the problem, the change, and why the change works. No prior
knowledge of the codebase is assumed.

## Background: what the engine stores and where

A signal engine tracks three kinds of node:

- **Signals** (writable values), **computeds** (cached derived values), and
  **effects** (callbacks that re-run when their inputs change).
- **Links** — the edges between them. Each link records "this computed read
  that signal" and is kept in two doubly-linked lists at once: the reader's
  dependency list and the source's subscriber list.
- Writing a signal pushes an invalidation **wave** down the subscriber lists;
  reading a computed **validates** by comparing logical-clock readings
  ("did any dependency change after I last proved myself current?") and
  recomputes only when the answer is yes.

In this engine, nodes and links live as fixed-size records inside one large
`Int32Array` (the **arena**). A record is identified by its integer offset.
The objects users hold — `Signal`, `Computed` — are thin **handles** that
carry the user-facing state (the value, the compute function, the equality
comparator) plus the integer id of their arena record. A **pin table** maps a
record id back to its handle for the few operations that must call user code.

The appeal of the arena: records are dense (32 bytes each, adjacent in
memory), traversal never allocates, and the graph's structure is invisible to
the garbage collector, so huge graphs cost neither GC tracing time nor
per-object header overhead. The cost: every access to node state is an
indexed load instead of a field load, and something must reclaim records,
because the garbage collector no longer does it for free. The optimizations
below attack both costs.

## 1. Reusable integer stacks for graph walks

**Problem.** The invalidation wave is an iterative traversal that needs a
stack to remember where it paused when a node has several subscribers. The
straightforward version allocates a small `{value, next}` object per pause —
garbage proportional to fan-out, on every single write.

**Change.** One module-lifetime `Int32Array` serves as the stack for every
wave. This is safe because the wave never runs user code (it only sets flag
bits and appends to queues), so it can never be re-entered mid-walk; a single
stack can serve every wave in the program forever.

The same idea replaced the free-record bookkeeping (section 10) and the
effect queue (section 5): whenever a data structure's lifetime is "one
operation" and the operation cannot nest, a persistent scratch buffer beats
allocation.

## 2. Pay for observability only while observing

**Problem.** The engine supports an attachable tracer that records why each
node was invalidated. Recording the cause is one extra array store per node
visited by every wave — paid even when no tracer has ever been attached.

**Change.** Cause bookkeeping is skipped entirely unless a tracer is
attached (one branch on a value the compiler can hoist out of the loop).
The same pattern gates the async machinery: computeds that suspend on
promises need an extra state probe on every read, so a single module flag
records whether *anything* has ever entered an async state, and until then
every read skips the probe. A fully synchronous application never pays for
features it does not use.

## 3. Reclaim by exact slots, not by ranges

**Problem.** Freeing a record must leave it clean for reuse. The obvious
`array.fill(0, start, end)` is a call into the runtime for every freed
record — far more expensive than the handful of stores it performs.

**Change.** Each record kind clears exactly the slots it can have dirtied,
as plain stores. A freed effect record, for instance, provably dirties only
three slots over its whole life (its dependency-list head, and its
validation watermark, plus a generation counter), because effects are never
anyone's dependency — so its reclaim is three stores. Slots holding
monotonic counters are never cleared at all: a stale reading of an
ever-increasing counter can never equal a future reading, so staleness is
harmless by construction.

## 4. Records on demand: nodes are born detached

**Problem.** Creating a signal allocated an arena record and registered the
handle with a `FinalizationRegistry` (the JavaScript facility that runs a
callback after an object is collected — needed so a dropped handle's record
can be reclaimed). Registration is the single most expensive step in
creation, and it bought nothing for the many signals that are created but
never wired into a graph.

**Change.** New signals and computeds own no record at all. Their id points
at one of two shared, read-only placeholder records whose only content is
the correct flag bits for their kind, so any code that reads flags by id
still gets the right answer with no special case. All real state lives on
the handle. The record — and the registry entry, when one is needed —
materializes at the node's first actual graph participation: its first
edge, first evaluation, or first write that something outside the graph
could observe.

A detached node is an ordinary JavaScript object with no external
resources: drop it and the garbage collector alone reclaims everything.
Creating 100,000 signals now costs less than in the object-based engine,
because the handle is one flat object and nothing else happens.

## 5. Cells never need the finalization registry

**Problem.** Even with lazy records, a signal that *does* join the graph
would need registry coverage so its record is reclaimed when the handle is
dropped. Registration cost therefore just moved from creation time to
first-read time.

**Change.** A signal's record has a natural owner already: its incoming
links. Every link holds a reference count on its source's record, and while
the count is above zero the pin table keeps the handle alive (correctly so —
live subscribers genuinely reference it). When the last link is freed, the
record **detaches**: it returns to the free pool immediately — synchronously,
earlier than any collector would get to it — and the handle's id points back
at the shared placeholder. The signal is again a plain object in the
detached state of section 4.

Only two cases still register with the finalization registry: computeds
(their records own outgoing dependency links that a dead handle must free,
and nothing else knows when the handle dies) and the rare signal
materialized by a write with no link (possible only while a tracer or a
transaction overlay is observing values from outside the edge graph). A
flag bit records which mechanism owns each record, so a record is freed by
exactly one of them, never both.

**Every path is covered — this is a strict improvement, not a trade.** The
engine's rule is that a leak is a bug: detached nodes are owned by the GC,
linked cell records by their links, computed records by the registry, and
effects by their disposers (with a registry safety net for disposers that
are dropped without being called). The leak test suite runs all of these
against a real garbage collector.

## 6. An effect queue of integers, stamped with generations

**Problem.** Scheduled effects sat in a JavaScript array of handles. Each
enqueue was a pointer store (with a GC write barrier) after a pin-table
lookup, and each drained slot had to be nulled so the queue's retained
capacity would not keep dead effects alive.

**Change.** The queue holds pairs of integers: the record id and the
record's **generation** — a counter bumped every time a record is reclaimed
or detached, and deliberately never reset, so an (id, generation) pair names
one lifetime of one record. Enqueueing is two integer stores into typed
arrays: no lookup, no barrier, nothing retained. At drain time, a pair whose
generation no longer matches the record's is a message to a dead recipient
and is skipped. The handle is looked up only for entries that will actually
run.

## 7. Feeding the JIT: small hot functions

**Problem.** V8 decides whether to inline a function by its *bytecode* size,
and typed-array field access compiles to roughly double the bytecode of an
object field access (an extra context load and index add per access). The
engine's hot functions — validate, recompute, track-a-read — had quietly
grown past the budgets, so the hottest call chain in the engine ran as real
calls instead of one inlined body.

**Change.** Everything cold was moved out of hot functions into their own
functions: error construction for cycle detection, the disposal of an
effect's children, cleanup callbacks, the freeing walk for dropped
dependency edges, transaction bookkeeping. What remains in each hot function
is only the code that runs on every invocation, and the whole hot cluster
fits the inlining budgets again. This class of fix is invisible in the code's
logic and worth 8–13% on propagation-heavy workloads.

## 8. Chains validate without recursion

**Problem.** Validation is naturally recursive: "am I stale?" asks each
dependency "are *you* stale?" first. Long chains of single-input computeds —
a very common shape — paid a full function-call frame, argument shuffling,
and bookkeeping per level.

**Change.** A chain of nodes that each have exactly one dependency and one
subscriber needs none of that generality. The engine walks *down* the chain
following the single dependency edges until it finds the deepest change (or
a node with nothing to resolve below it), then walks back *up* through the
unique subscriber edges; at each level, one clock-reading comparison decides
"recompute" versus "mark current". Two tight loops, no stack, no frames. Any
shape that breaks the assumption — a branch, a shared node — bails out to
the general path before touching anything. Deep-chain propagation went from
1.4x slower than the object engine to parity.

## 9. The compiler must be able to trust the arena binding

**Problem.** The arena array was a module-level `const`. Bundlers rewrite
top-level declarations to `var`, and a `var` binding can never be treated as
constant — so in bundled output, *every* arena access re-loaded the binding
from its context slot, and no access could be folded or reused across a
function call. This is invisible in source and cost double-digit percentages
on wide propagation.

The rewrite is not a language-target problem a modern toolchain has
outgrown; it is inherent to bundling. Concatenating many modules into one
scope reorders module bodies, so one module's initializer can reference
another module's binding before that binding's own declaration has executed
in the merged scope. A `const` there would throw a temporal-dead-zone error;
a hoisted `var` plus an assignment cannot. Emitting `const` safely would
require proving initialization order across the whole module graph, so the
esbuild family of tools (and the dev servers and packagers built on it)
emits `var` unconditionally. A library does not choose its consumers'
bundlers — and even preserved top-level `const` in unbundled native modules
is only foldable where the engine has shipped const-tracking for that
context kind, which has arrived piecemeal. Function-scope `const` is the one
binding class optimizing compilers have treated as reliably immutable for a
decade.

**Change.** Two layers of defense, making the engine's performance
independent of what any toolchain emits. The engine core is one function,
instantiated exactly once, whose closure binds the arena views as
function-scope `const`s — a scope bundlers do not rewrite. And each hot
function additionally opens with local `const` views of the arrays it
touches, so even where the compiler cannot prove the outer binding constant,
the load happens once per call instead of once per access.

## 10. Free lists that don't chain loads

**Problem.** Freed records were kept on an intrusive free list — each free
record storing the id of the next — so every allocation *read the record it
was allocating* to find the next head. That makes each allocation depend on
the previous one's memory load: a serial pointer chase, in exactly the
mass-create patterns where allocation dominates.

**Change.** Free ids live in a plain integer stack (a typed array and a
count). Pops are independent indexed loads the CPU can overlap; pushes are
appends. A dense create-and-dispose lifecycle benchmark dropped from 11.3ms
to 3.7ms from this change alone.

## 11. State lives where its consumers look

Three placement decisions, one principle: put each field where the code that
touches it most already has an addressing base, and never split one node's
hot state across two bases.

- **The dependency cursor moved onto handles.** Tracking a read touches an
  append cursor twice, and every touching site already holds the handle —
  so it became a handle field (one field load) instead of a record slot (an
  id load plus an indexed load). It could move because no id-only code path
  ever needs it.
- **Records went back to 8 words.** An experiment widened node records to a
  full 64-byte cache line so all per-node fields lived together. Measurement
  said no: traversal did not get faster (the hot words already shared a
  line) and creation paid double the arena footprint. Fields that did not
  fit the 8-word record went to per-field side arrays indexed by record
  number — dense, prefetch-friendly, touched only by the operations that
  need them.
- **Nodes and links allocate from opposite ends of the arena.** Nodes bump
  upward from the bottom, links downward from the top. Node records stay
  densely packed (validation walks touch adjacent memory), tables indexed
  by node record cover only the node region, and link allocation loses its
  table-growth check entirely.

## What didn't work, and where the limit is

Honest negatives, because they shape the design as much as the wins:

- **Bounds checks were never the problem.** Masking every index to provably
  fit the array (`i & MASK`) changed nothing or hurt. V8's typed-array
  bounds checks are effectively free on these access patterns; early
  attempts to blame them were wrong.
- **Cache-line colocation of node fields was a wash** (section 11) — the
  reverted 16-word record experiment.
- **The remaining ~6% is a boundary cost, not slack.** Node state is
  consulted two ways: through the handle (reads, recomputes) and through the
  raw record id (the wave, the validation loops). Moving any field to the
  handle side makes the id side pay an extra lookup, and vice versa — the
  split representation pays double addressing at whichever boundary it
  draws. An engine whose nodes are plain objects keeps *all* per-node state
  behind one pointer and wins every workload that fits in cache; the arena
  wins every workload that does not, plus creation and reclamation. The two
  designs are each optimal on their own side of the cache line, and no
  hybrid we could count or measure beats both.

## How this was measured

All numbers come from a standard reactivity benchmark suite (20 workloads:
creation, updates, propagation shapes, and large dynamic graphs) run as
three-round isolated comparisons — each engine in a fresh child process,
medians per round — on a quiet machine, repeated across independent runs to
bound noise. Every optimization landed only after the full test surface
passed: the unit suite, a 179-case conformance suite, a randomized fuzzer
checked against a reference implementation (up to 10,000 seeds), and a
garbage-collection leak suite run against a real collector.
