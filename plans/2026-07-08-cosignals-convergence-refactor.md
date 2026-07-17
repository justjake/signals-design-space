# cosignals-first-draft convergence refactor

Status: implemented. The decisions marked **LOCKED** below are the resulting
contract. Earlier refactor plans are historical evidence, not the target
architecture.

Implementation outcome:

- `SignalEffect` is a committed-arena graph terminal with ordinary packed
  dependency links; snapshot notification state and its compatibility API are
  gone.
- `useSignalEffect` has one stable cleanup/body owner and causally arbitrates
  React and signal requests; signal-only runs schedule no React render.
- `createCosignals()` owns all mutable state per invocation. Named exports use
  one default browser instance; SSR creates one instance per request.
- The semantic state machine is in `CosignalEngine.ts`; `index.ts` is only a
  curated re-export list. The former callback-bag modules were deleted.
- Committed graph state stays packed. Temporary render worlds use small JS
  arrays and are reclaimed with the render.

## Refactor frame

These decisions were already made:

- **LOCKED — request-isolated SSR:** `createCosignals()` creates a real engine
  instance. Mutable graph, world, lifecycle, async, and reclamation state is
  per instance. The browser API may expose one default instance. State
  serialization and initialization require no live batch or render.
- **LOCKED — flatten before splitting:** initially colocate the semantic state
  machine in one engine module. Extract only acyclic leaves that own their
  representation and do not need an `EngineCore`-shaped callback bag.
- **LOCKED — storage follows lifetime:** persistent, repeatedly traversed graph
  edges stay packed; episode/render bookkeeping stays on the JS heap. Build the
  arena and JS world-storage candidates as an A/B, select per world kind, and
  delete losers rather than ship two complete concurrent engines.

## `useSignalEffect`: one effect, two invalidation planes

### Intent — LOCKED

`useSignalEffect(fn, reactDeps)` is one effect whose execution can be requested
by either:

1. a change to `reactDeps` in a committed React render; or
2. a change reaching a signal read by the effect's last execution.

The two requests converge on one cleanup/body lifecycle. If the same signal
change reaches the effect through both React and signal propagation, the body
runs once with the committed React closure and committed signal values.

For example, after `a.set(1)` this logs only the second row:

```text
{ aFromReact: 0, aFromSignal: 0 } // mount
{ aFromReact: 1, aFromSignal: 1 } // one converged update
```

It must not first run `{aFromReact: 0, aFromSignal: 1}` and then run again from
React's dependency change.

### Observable contract — LOCKED

- The initial body runs once after mount.
- A React-deps-only change runs it once.
- A signal-only change runs it once **without scheduling a React render**.
- Signal and React notifications caused by the same batch and consumed by the
  same committed render run it once.
- Separate committed causes may produce separate runs; there is no wall-clock
  debounce across unrelated work.
- Multiple signal notifications coalesced into one causal batch require at
  most one run for that batch.
- A discarded render consumes nothing and runs no body.
- If matching React work suspends, the effect waits for that work's
  commit/discard or for the batch's durable disposition. It does not race the
  render using an older React closure.
- Cleanup runs exactly once before each actual rerun and once at unmount.
- Untracked signal reads create no dependency edge.

## Mechanism

### Real terminal graph node — LOCKED

Replace the current snapshot-scanned `Subscription` with a real
`SignalEffect` terminal node. Reads during the body create ordinary dependency
edges to that node. Retracking removes stale edges. Those edges participate in
ordinary observation/lifecycle liveness.

A write reaching the node marks a run request with its causal batch/root data;
it does not immediately invoke user code.

### Causal arbitration — LOCKED

After propagation finishes:

- If the cause scheduled no matching React work, run directly using the last
  committed React closure. This is the signal-only path and performs no React
  update.
- If the same cause scheduled React work, defer it. A render-time hook report,
  owned by that render attempt, records whether the `useSignalEffect` instance
  participated. Discard drops the report.
- If a matching render commits and React's dependency path will run the effect,
  that passive run consumes the signal request.
- If the render does not contain the hook or its dependency path does not run,
  execute the still-pending signal request directly after the relevant commit.
- If scheduled work is abandoned but the write later becomes durable at
  retirement/settlement, execute the unconsumed request then.

Arbitration uses causal identities already carried by the protocol — batch,
root, and render pass — never a timer or "same tick" guess.

### One cleanup/body owner — LOCKED

The hook keeps one stable effect registration across React dependency changes.
Its runner owns the current cleanup and an execution generation. Both React and
signal paths request that runner; neither owns a second cleanup closure. A stale
React cleanup is generation-checked so a signal-only rerun cannot make it run
the same cleanup twice later.

### Ownership boundary — LOCKED

Engine mechanism:

- graph node, dependency edges, dirtiness, and retracking;
- causal batch/root bookkeeping and per-batch dedup;
- commit/discard/retirement arbitration;
- observation/lifecycle retains.

React adapter policy:

- React dependency comparison and render-attempt participation report;
- the last committed React closure;
- passive-effect invocation and unmount/StrictMode integration.

The engine never interprets the user's React dependency array. The adapter
never maintains a second signal dependency graph.

## Required deletions

The completed implementation must delete, not preserve beside `SignalEffect`:

- the global committed-subscription boundary scan;
- subscription dep snapshots used for notification;
- one-sided observer arena chains and their parallel stamps;
- the subscription observation `Set` mirror;
- immediate engine-to-user refire callbacks;
- `holdingRefires` / `heldRefires` body-execution timing;
- dependency-change teardown/recreation of the whole subscription record.

Diagnostic trace snapshots may be materialized only when tracing is enabled;
they are not live dependency state.

## Regression schedules

1. **Dual-plane convergence:** the Parent/Child example above produces one
   update run and never observes old React props with new signal state.
2. **Signal-only:** a captured signal change runs the effect while render counts
   remain unchanged.
3. **React-only:** a user dependency change runs once and retracks signals.
4. **Same root, unchanged deps:** unrelated React work does not lose a pending
   signal-only run.
5. **Transition commit:** signal and React causes in one transition commit run
   once after commit.
6. **Transition discard/durable retirement:** discard consumes nothing; a later
   durable disposition runs the still-pending cause exactly once.
7. **Suspended render:** no old-closure early run; commit/discard resolves the
   pending cause.
8. **Cleanup and StrictMode:** every actual run has one preceding cleanup, and
   unmount cleans once with no post-unmount run.
9. **Lifecycle liveness:** adding, flipping, and removing dynamic dependencies
   moves `AtomOptions.effect` observation exactly once per real edge change.
10. **Render-attempt overwrite:** if one hook renders more than once in the
    same pass, only its final React-dependency report participates in commit.
11. **Body write:** a signal write from the body queues any rerun until the
    current dependency frame closes and does not render the component.

Before conversion, the exact Parent/Child schedule was red with three observed
rows: mount, mixed old/new, then converged new/new. It now passes with the mount
row and one converged update row; the signal-only baseline remains green.
