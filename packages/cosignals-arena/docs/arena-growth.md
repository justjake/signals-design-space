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

## Why growth applies only at an empty stack

Node and link records are offsets into module-level typed arrays, and
hot functions open function-local views of those arrays once per
activation (`const mem = M`). A frame that is still running when the
arrays are replaced would keep writing through its stale view, and any
link offset it holds in a local would address the wrong record after
relocation. So the arena may only move when no engine frame is live.

User callbacks run under engine frames from many directions — compute
bodies, handlers, cleanups, equality callbacks, lazy initializers,
observation lifetime callbacks, tracer sinks, the devtools hot hook —
and any of them could call `growCapacity`. Instrumenting every such
entry with a busy bracket would tax hot paths and stay fragile against
the next callback surface added. Instead, growth never applies
synchronously under user code at all: it applies only from its own
microtask, where the JS stack is empty. Engine frames cannot span a
microtask boundary — evaluations and drains unwind by throw rather than
suspend — so the only engine state that can still be live there is a
batch held open across `await`, which `batchDepth` covers. A growth
deferred by such a batch re-arms when the outermost batch closes and
whenever a fresh record allocation still sees the gap below the
trigger.

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

- **Before the first growth: nothing.** The array bindings are `let`,
  but V8 treats a context slot as constant until its first reassignment,
  so the pre-growth hot path compiles exactly as the fixed-capacity
  arena did. The trigger check is one compare on the fresh-record
  allocation path (free-list reuse never changes the gap and skips it).
- **At growth: one copy of the live regions** plus the delta rewrite,
  both linear in live records, and a one-time deopt of functions that
  embedded the old array constants.
- **After a growth: one context load per function activation** to open
  each local view — the same cost the module-level bindings already
  paid, since a bundler emits module state as mutable context slots.

`resetEngineForTest` and the benchmark reset keep the grown capacity;
they rewind the allocation pointers within it.

## Testing

`setArenaCapacityForTesting(records)` (test entry only) migrates to a
smaller arena so suites can exercise the trigger and the migration with
tiny graphs instead of allocating millions of records. It must be called
from test top level (the same empty-stack footing the growth microtask
runs on); shrinking below the live regions throws.
