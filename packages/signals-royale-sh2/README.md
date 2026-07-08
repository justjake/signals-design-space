# signals-royale-sh2

A small reactive engine built around a numbered slab. Values live in flat slots and dependency
edges live in bit masks, so invalidation scans words and never allocates per-edge objects.

Atoms are writable, computed values are lazy and cached, effects are synchronous, and `batch`
coalesces effect work. Function-valued atom inputs are lazy initializers: they run once at first
materialization rather than at construction.
