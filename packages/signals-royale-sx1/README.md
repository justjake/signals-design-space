# signals-royale-sx1

A small reactive engine whose writes are operations on one ordered timeline. Ordinary reads fold the committed operations, concurrent renders add their own React batches to that fold, and `latest` adds every live batch. Writable atoms, cached computed values, effects, scopes, batching, async reads, lifetime observations, and server state transfer all use the same graph.

The package has no runtime dependencies and ships its TypeScript source directly.
