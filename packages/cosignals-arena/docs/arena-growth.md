# Arena growth: automatic capacity, in-place migration

This document is the design for arena growth: when the record arena
grows, how a live graph moves to the bigger arena, and why growth is
safe to apply only at the moments it is applied.

## The behavior

The arena starts at 2,097,152 records (32 bytes each; the typed buffers
are virtual pages, committed on first touch). It no longer has a fixed
ceiling at that size:

- **Automatic growth.** When the free gap between the node region and
  the link region falls below a quarter of capacity, the engine
  schedules a growth to double capacity. The growth applies at the next
  quiescent moment (see below), never in the middle of an operation.
- **Explicit growth.** `growCapacity(records)` raises capacity to at
  least `records`. On an arena no operation has touched yet (app
  startup, before any signal is created — the intended call site) it
  applies immediately, so a caller can pre-size and mass-build in the
  same task. On a touched arena it applies at the next microtask.
  Requests at or below the current capacity are no-ops. Growing under a
  warm graph pays a one-time copy of every live record, so prefer
  calling it before the graph is built.
- **Ceiling.** Capacity is capped at 134,217,728 records (2^27; record
  word offsets must stay well inside int32 range). `growCapacity` past
  the ceiling throws a `RangeError`.
- **Exhaustion still throws.** A single synchronous operation that
  allocates through the entire remaining quarter of headroom before any
  quiescent moment arrives still exhausts the arena and throws a
  `RangeError`. The quarter-capacity trigger makes this take hundreds of
  thousands of allocations inside one operation.

## Growth rebuilds the engine, one generation per arena

The engine is a closure whose typed-array views bind as function-scope
consts, which an optimizing compiler embeds as constants across the hot
walks. Growth must not give that up: making the view bindings mutable
was measured 12-14% slower geomean across the graph benchmarks (a
binding with any assignment site is never constant-folded), and
resizable ArrayBuffers measure worse still. So a generation's arrays
NEVER move. Growth builds the bigger arrays, then instantiates a fresh
engine closure — the next generation — over them, handing the hot
state (allocation pointers, free stacks, clocks, pass counters, effect
lanes, pending queues, the finalization registry) across by value or by
stable reference.

Everything that outlives a generation reaches the engine through module
scope, never through a captured closure-internal function:

- The public surface is a set of stable wrapper identities delegating
  to the current generation. A caller may capture any of them by VALUE
  (destructure, store in a callback) and the capture keeps working
  after a growth; rebindable `export let` bindings alone would not
  cover value captures, only live-binding references.
- Disposers, retained observation-lifetime `ctx.get`/`ctx.set`
  callbacks, and the finalization registry's cleanup all route through
  the current-generation slot.
- Scheduled drains (microtask and timer pumps) go through module
  trampolines that resolve the engine at run time.

## Why a generation turns over only at an empty stack

A live engine frame holds function-local views of its generation's
arrays and link offsets in locals; a turnover under it would strand
both. User callbacks run under engine frames from many directions —
compute bodies, handlers, cleanups, equality callbacks, lazy
initializers, observation lifetime callbacks, tracer sinks, the
devtools hot hook — and any of them could call `growCapacity`.
Instrumenting every such entry with a busy bracket would tax hot paths
and stay fragile against the next callback surface added. Instead,
growth applies only from its own microtask, where the JS stack is
empty. Engine frames cannot span a microtask boundary — evaluations and
drains unwind by throw rather than suspend — so the only engine state
that can still be live there is a batch held open across `await`, which
the idle check covers. A growth deferred by such a batch re-arms when
the outermost batch closes and whenever a fresh record allocation still
sees the gap below the trigger.

The one synchronous exception is `growCapacity` on a never-touched
arena (neither bump pointer has moved): no record exists for any engine
frame to be operating on, so replacing the empty arrays immediately is
safe, and the startup pattern — pre-size, then build — works within one
task.

## Migration

Node records allocate upward from the bottom of the arena and link
records allocate downward from the top. Growth allocates new arrays and
moves both regions:

- **Node region: copied verbatim.** Node ids are offsets from the
  bottom, so every node id — in handles, in the pin table, in effect
  queues, in the finalization registry — survives unchanged. The side
  columns (validation watermarks, observer counts, poke passes,
  generations) are indexed by node record number and also copy verbatim.
- **Link region: relocated by a constant delta.** Link ids are offsets
  anchored to the top of the arena, so the region copies to the new top
  and every stored link offset moves by `delta = newWords - oldWords`.
  Stored link offsets live in exactly three places, all enumerable:
  node records (`Deps`, `Subs`, `SubsTail`), link records (`NextDep`,
  `PrevSub`, `NextSub`), and the free-link stack. The rewrite adds
  `delta` to every nonzero slot. Freed node records are zeroed at
  reclaim and freed link records carry only stale-but-dead values, so
  blanket-rewriting both regions is safe.
- **Everything else rides by reference.** The pin table, free-node
  stack, effect lanes (record id + generation pairs), render-notify
  queue, pending registrations, and the finalization registry all hold
  node ids or handles, which growth does not disturb.

The one other place a raw link offset persists is the `depsTail` cursor
on handles. It is dead state between operations: every evaluation zeroes
it before the first read (`recompute`), and disposal zeroes or discards
it. Growth only runs at an empty stack, where no evaluation is live, so
stale cursors are never observed and need no fixup.

The clock view (`Float64Array`) shares the record buffer, so change
stamps copy bit-exact with the int32 copy.

## What growth costs

- **Steady state: one current-generation load per public call.** Each
  public entry loads the current-engine slot and a property before the
  direct engine call; engine-internal calls (the walks, the drains, the
  evaluators) stay direct closure calls over const-embedded arrays. The
  trigger check is one compare on the fresh-record allocation path
  (free-list reuse never changes the gap and skips it).
- **At growth: one copy of the live regions** plus the delta rewrite,
  both linear in live records, and a fresh engine instantiation.
- **After a growth: mixed-generation call-site feedback.** The second
  instantiation of the same engine literals shares their feedback slots,
  so post-growth code runs somewhat despecialized. Growth is expected to
  be rare and mostly pre-graph (`growCapacity` at startup); if
  post-growth steady state ever matters, dalien-signals' answer —
  compiling each generation from its own source text via `new Function`
  for fresh function identities — is the known fix, at the price of
  requiring a runtime-codegen-permitted host and a self-contained
  factory.

`resetEngineForTest` and the benchmark reset keep the grown capacity;
they rewind the allocation pointers within it.

## Testing

`setArenaCapacityForTesting(records)` (test entry only) migrates to a
smaller arena so suites can exercise the trigger and the migration with
tiny graphs instead of allocating millions of records. It must be called
from test top level (the same empty-stack footing the growth microtask
runs on); shrinking below the live regions throws.
