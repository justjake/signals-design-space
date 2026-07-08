# React + Signals Lab

This monorepo explores one question: **how can a fine-grained signals graph
participate in React's concurrent rendering without tearing, losing updates, or
turning every transition into synchronous work?**

It is a research lab, not one finished package. It contains small reactive
kernels, full concurrent engines, React forks and bindings, executable reference
models, adversarial tests, browser demos, and benchmarks. The useful output is
both the implementations and the record of what failed.

## Map

### Implementations

| Path | What it explores |
| --- | --- |
| [`packages/cosignals`](packages/cosignals/) + [`packages/cosignals-react`](packages/cosignals-react/) | The most complete in-tree design: a packed push-pull graph, operation journals, per-render and per-root views, async resources, tracing, reclamation, and bindings to the React fork. |
| [`packages/strata`](packages/strata/) + [`packages/reack-strata`](packages/reack-strata/) | A smaller branch/journal formulation. The graph stores committed state; React renders fold the operations belonging to their lanes over that base. |
| [`packages/concurrent-solid-react`](packages/concurrent-solid-react/) | A minimum-evolution experiment based on Solid 2.0's double-buffered values, transitions, async graph state, and scheduler. It asks how much of an existing concurrent signals engine can be hosted by React. |
| [`packages/cosignals-alt-a`](packages/cosignals-alt-a/) and [`packages/cosignals-alt-b`](packages/cosignals-alt-b/) | Independent implementations of the two arena specifications. They are valuable counterexamples for write-gate activation, overlays, per-world state, and fork size. |
| [`packages/dalien-signals`](packages/dalien-signals/) | A data-oriented fork of alien-signals. Nodes and links live in an `Int32Array` arena; this is the main packed-layout baseline without the full React world model. |
| [`libs`](libs/) | Focused kernels and A/B probes: the alien control, graph-free `sweep`, array-edge `arrayd`, the arena port, links-only and host-boundary variants, and read/hook tax probes. |
| [`upstream-alien-signals`](upstream-alien-signals/) | The upstream semantic and performance baseline. Its compact linked push-pull core is difficult to beat across every graph shape. |
| [`vendor/react`](vendor/react/) + [`fork`](fork/) | The patched React host and its build/test tooling. The fork reports write batches, render attempts, root commits, retirement, and the DOM mutation window, and can schedule a correction back into its causal batch. |

### Libraries surveyed

[`research/LIBRARIES.md`](research/LIBRARIES.md) is the detailed study guide.
The vendored sources let experiments compare algorithms instead of comparing
README claims.

| Library | Useful idea or warning |
| --- | --- |
| [`alien-signals`](upstream-alien-signals/) | Quad-linked dependency edges, exact dynamic-dependency trimming, and a very small dirty/check push-pull state machine. |
| [`anod`](vendor/anod/) | Inline-first array edges, tombstones, scratch-stack retracking, level buckets, and an explicit single-dependency fast mode. Especially strong on wide graphs. |
| [`reactively`](vendor/reactively/) | The clearest small implementation of clean/check/dirty coloring over arrays. |
| [`Solid 2.0`](vendor/solid/) | Linked dependencies plus height-ordered scheduling, optimistic transition lanes, and pending/error as graph state. |
| [`Svelte 5`](vendor/svelte/) | Per-node read/write versions, prefix-reused dependency arrays, and async forks. |
| [`Preact Signals`](vendor/preact-signals/) | The quad-linked edge design alien-signals refined, a global quiet-version fast path, and lazy subscription of computed nodes. |
| [`signia`](vendor/signia/) | Salsa-like changed/verified epochs, liveness, transactions, and bounded diff histories used in tldraw. |
| [`cellx`](vendor/cellx/) | Intrusive dependency lists with very low per-node work; also a demonstration that removing edge objects constrains graph sharing. |
| [`lite-signal`](vendor/lite-signal/) | Pooled linked edges and useful retracking fixes. Its abandoned typed-array version is a reminder that fewer allocations do not automatically mean faster topology changes. |
| [`Leptos`](vendor/leptos/) | Two generations of a Rust graph: a slot-map arena and a later `Arc`/weak-edge design, with unusually clear evidence about ownership and leaks. |

### Evidence and tools

| Path | Purpose |
| --- | --- |
| [`harness`](harness/) | The shared 179-case conformance runner, isolated core benchmarks, memory probes, and inlining checks. Results are invalid unless conformance is green. |
| [`milomg-reactivity-benchmark`](milomg-reactivity-benchmark/) | The core reactivity workload suite used by the harness. Each framework runs in its own process to avoid order and JIT bias. |
| [`packages/react-seam-bench`](packages/react-seam-bench/) | Measures what React pays: write-to-commit fan-out, urgent latency during a large transition, and mount cost. |
| [`packages/react-signals-playground`](packages/react-signals-playground/) | One browser app running four implementations through the same shim, plus a Playwright battery and a plain-React control page. |
| [`packages/cosignals-oracle`](packages/cosignals-oracle/) | A deliberately slow, obvious reference model, invariant checker, seeded schedule generator, shrinker, and lockstep engine referee. |
| [`royale`](royale/) | The independent-rewrite tournament: a shared 25-case real-React battery, fork/library line counts, leak gates, fuzz requirements, and comparable benchmark adapters. |
| [`daishi-concurrent-benchmark`](daishi-concurrent-benchmark/) | An independent suite of externally observable concurrent-store failure schedules. |
| [`spec`](spec/) | The mechanism-free [`React Compliance Contract`](spec/react-compliance-contract.md), the cosignals spec, and the branching-store model. |
| [`research`](research/), [`plans`](plans/), [`reviews`](reviews/), [`design-loop`](design-loop/) | Source studies, measured results, implementation plans, adversarial reviews, and the multi-round design record. These explain why apparently simpler mechanisms were rejected. |

Useful commands from the repository root:

```sh
pnpm fork:build                                  # build the patched React
pnpm fork:test                                   # run its batch-registry gate
FRAMEWORK=cosignals pnpm -C harness conformance  # 179-case core contract
pnpm -C harness bench --frameworks cosignals,alien-v3
pnpm -C harness memory --frameworks cosignals,alien-v3
pnpm -C harness typecheck
pnpm play                                        # open the shared browser lab
```

## React and Signals

### Signals in a minute

A **signal** is a mutable cell whose reads can be observed. A **computed** is a
cached function of signals. An **effect** is work that re-runs when the values it
read may have changed.

```ts
import { Atom, Computed, batch, effect } from 'cosignals';

const count = new Atom(1);
const doubled = new Computed(() => count.state * 2);

const stop = effect(() => {
  console.log(doubled.state);
}); // 2

batch(() => {
  count.set(2);
  count.set(3);
}); // one effect run: 6

stop();
```

While the computed or effect runs, the signals engine records its reads. The
result is a directed dependency graph:

```text
count ──> doubled ──> effect
```

The graph is dynamic. A computation such as `enabled ? a.state : b.state`
must unsubscribe from `a` and subscribe to `b` when the condition flips.
Correct engines also provide equality cutoffs, lazy computeds, cleanup, nested
effect ownership, untracked reads, and glitch freedom: an observer never sees
one input before another input from the same synchronous batch has caught up.

Most fast engines use **push-pull** propagation. A write pushes a cheap dirty or
"check me" mark toward observers. A later read pulls only the necessary
computeds up to date. If a computed re-evaluates to the same value, propagation
can stop along that path. A signal `batch()` merely delays effect flushing and
coalesces notifications; it is not the same thing as a React render batch.

Signals resemble React concepts, but the lifetimes differ:

| Signal concept | Rough React analogy | Important difference |
| --- | --- | --- |
| atom/signal | `useState` | Usually exists outside any component or Fiber. |
| computed | `useMemo` or a selector | Tracks signal reads automatically and can be shared by many consumers. |
| effect | `useEffect` | Usually scheduled by the signals engine, so a React binding must explicitly align it with commits. |
| dependency edge | a component dependency | React does not normally know that a component read a particular signal. |

Fine-grained frameworks such as Solid own both the signals scheduler and the DOM
renderer. React does not. A standalone signals library therefore has to bridge
two schedulers with different ideas of state lifetime.

### React's ordinary render loop

React rendering has two broad phases:

1. **Render:** call components and reconcile their output into a candidate tree.
   Render must be pure. React may repeat it, pause it, or throw it away.
2. **Commit:** make one finished tree current and apply its host mutations.
   Layout effects run after mutation; passive effects normally run later.

Without concurrency, it is tempting to imagine render and commit as one
continuous operation. Concurrent rendering deliberately breaks that intuition:
React can work on a low-priority tree in slices, return to the event loop, commit
urgent work, and then restart or resume the low-priority work.

### Batches, lanes, Fibers, and commits

These four terms are enough to follow the rest of the repository:

| Term | Mental model |
| --- | --- |
| **Batch** | A causally related group of updates: for example, updates from one click, transition, or async action. Public React also "batches" several setters into fewer renders. This repo gives the group a stable identity because stock React does not expose one. |
| **Lane** | A bit in React's priority/work set. Sync, input, default, transition, retry, and idle work occupy different lanes. The scheduler selects the highest-priority unblocked lanes. A lane bit can later be reused, so it is not by itself a durable update identity. |
| **Fiber** | React's record for a component or host node. Fibers form a tree and contain props, state, update queues, dependencies, pending lanes, and effect flags. Updated Fibers normally have a `current` record and a work-in-progress `alternate`. |
| **Commit** | The non-interruptible publication of a finished root. React applies mutation effects, swaps `root.current` to the finished Fiber tree, runs layout work, and schedules passive work. Different roots commit independently. |

A simplified update looks like this:

1. A setter appends an **operation** to a Fiber's update queue and assigns it a
   lane.
2. The root records that lane as pending. The scheduler chooses the next lanes.
3. React renders a work-in-progress Fiber tree for those lanes. Updates in other
   lanes are skipped, but retained.
4. React may yield. Higher-priority work can interrupt it; Suspense can park it;
   another attempt may replace it.
5. When a tree finishes, React may still check that external-store snapshots did
   not change before publishing it.
6. Commit makes that particular result visible. Skipped work remains queued for a
   later render.

The update queue is why operations matter more than snapshots. Start at `1`,
enqueue a transition update `x => x + 1`, then urgently enqueue `x => x * 2`.
The urgent render skips the transition and shows `2`. Later React starts from the
old base, applies the transition update, and replays the urgent operation after
it, producing `(1 + 1) * 2 = 4`. A store that saved only either precomputed
"next value" would lose this history.

### Where a normal signal breaks

A traditional signals graph has one current value per atom and one current
dependency set per computed. Concurrent React can need several coherent answers
at once:

```text
on screen                 page = "home"
transition render         page = "settings"   (paused)
urgent render             page = "home", count = 2
plain event-handler read  an explicitly defined canonical/latest view
```

Suppose a transition mutates `page`, renders half the tree, and yields. An urgent
click now updates `count` and mounts a component that reads `page`. If every read
uses one globally mutated signal head, the new urgent component sees
`"settings"` beside committed siblings that still show `"home"`. If the paused
transition resumes after another write and sees a newer head than it saw in its
first slice, even one render can contain two generations. Both are **tearing**.

There are two honest integration levels:

| Integration | What it guarantees | Trade-off |
| --- | --- | --- |
| `useSyncExternalStore` | React reads a cached immutable snapshot, checks it again before a concurrent commit, and forces a synchronous re-render when a subscription changes. This is the correct general adapter for an ordinary external store. | Store updates are synchronous from React's point of view. A store mutation inside `startTransition` cannot remain a non-blocking transition. |
| Concurrent-native store | The store can answer reads for a particular render attempt, knows when that attempt commits or is discarded, and schedules notifications at their causal priority. | Public React does not expose enough lifecycle information. The experiments use a small React seam plus a branchable signals engine. |

The standard adapter is not “wrong”; it chooses consistency over background
external-store rendering. The rest of this repo studies what is required when
that de-optimization is not acceptable.

### What a concurrent-native signals integration must do

The full behavioral version lives in
[`spec/react-compliance-contract.md`](spec/react-compliance-contract.md). The
following is the practical checklist.

1. **Classify every piece of state by lifetime.** The useful four-way split is:

   | Lifetime | Examples | When it ends |
   | --- | --- | --- |
   | committed application state | durable atom values | never because a render was discarded |
   | pending-batch state | transition operations and batch membership | when that batch retires |
   | render-attempt state | a speculative dependency set, hook instance, or frozen view | when that attempt commits or is discarded |
   | resource state | a keyed pending/settled request | according to the resource cache, not a render lane |

   Putting attempt state in a durable write log leaks discarded renders into
   reality. Putting resources in positional render slots aliases requests from
   different worlds. Most subtle failures in the design history are lifetime
   mistakes before they are algorithm mistakes.

2. **Give writes stable causal identity.** A write must be associated with the
   React update group that issued it and classified as urgent or deferred. Lane
   bits alone are recycled, so the current fork gives live batches stable ids.
   The store records `set`, functional-update, or reducer operations in arrival
   order rather than flattening them prematurely to values.

3. **Freeze one view for each render attempt.** At render start, capture the
   root's committed base, the batches React says this pass includes, and a
   sequence pin. Every read in every slice of that attempt must resolve against
   that same view. A write during a yield becomes visible only to a later attempt;
   it never silently moves the old attempt's snapshot.

4. **Keep the meanings of “current” separate.** At minimum there is a render
   view, a committed view for each root, and a newest/latest view that can include
   pending intent. APIs such as `latest`, `committed`, and `isPending` should say
   which one they mean. Code running in an event handler during a yielded or
   completed-but-not-committed frame is not render code and must not inherit that
   frame's view accidentally.

5. **Replay and rebase like React.** Urgent work may commit while a transition is
   pending. When the transition later renders, its functional operations must be
   replayed in deterministic insertion order over the right base. Equality is
   applied at the correct step and in the correct world; a write that looks like
   a no-op against one head can still change another branch.

6. **Track dependencies per coherent world.** Consider
   `computed(() => flag.state ? a.state : b.state)`. The committed world may
   depend on `b` while a transition world depends on `a`. Publishing one global
   dependency set from the speculative evaluation can make an urgent write to
   `b` disappear. Each live world therefore needs sound dependency and cache
   state of its own, or an equally strong validation scheme. The current main
   line keeps real per-world dependency records.

7. **Deliver invalidations in the causal lane.** A transition write must schedule
   its component work back into the transition; an urgent correction must remain
   urgent. Notification is often deliberately value-blind because the answer to
   “did this value change?” depends on the receiving world. Bounded extra renders
   are safe; missing the one render whose view changed is not.

8. **Keep render pure and speculative tracking disposable.** Shared signal writes
   during render must fail. A render may collect the signals a component read,
   but discarded work must leave no durable subscriber, effect, cache mutation,
   or observation lifetime behind. Replays with the same inputs must return the
   same answer, and Strict Mode's extra render/mount cycle must net to one live
   subscription.

9. **Close the render-to-subscribe gap.** A component normally subscribes only
   after its first render commits. In between, a write can be missed. The binding
   must claim the subscription at commit, check whether committed state moved,
   and—before paint—correct urgently or join every still-pending batch that
   touched what the component rendered.

10. **Advance committed state per root and retire batches exactly once.** A batch
    can span roots that commit at different times. Each root needs its own
    on-screen view and commit generation; cross-root atomic display is not a React
    guarantee. The repo's contract also makes data durable even when React
    abandons the render: abandonment discards speculative UI, not accepted writes.

11. **Align effects with the world they are allowed to observe.** A plain engine
    effect and a React-bound effect are different terminals. React-level effects
    may run user code only from committed state, after the relevant boundary, and
    must coalesce React-dependency and signal-dependency invalidations into one
    cleanup/body lifetime. Otherwise an effect can observe old props with new
    signal state or run for a UI that never committed.

12. **Treat Suspense and async work as state, not a thrown-promise trick.** A
    pending/error/settled result belongs in the graph. A living request must reuse
    the same thenable across retries; resource keys must include every input that
    changes the request; independent reads should be registered before the
    computation parks. Settlement invalidates dependents like a write. First load
    may suspend, while a refetch can serve stale committed content with
    `isPending` until the owning transition lands.

13. **Handle special React paths explicitly.** `flushSync` must not drag a pending
    transition into its urgent frame. Async action writes after `await` are urgent
    unless explicitly re-wrapped, matching React. SSR needs request-isolated graph
    state and a hydration snapshot that does not run lazy initializers as writes.
    Unmount, pruning, render restart, errors, Suspense retries, and multiple roots
    are normal paths, not cleanup edge cases.

14. **Make the quiet path boring and reclaim the busy path.** When no deferred
    batch, render attempt, or parked action exists, a write should use the ordinary
    signals fast path without allocating a world or journal entry. Attempt and
    batch state should die at discard/retirement/quiescence; dropped handles and
    subscriptions must not pin graph records forever.

15. **Verify schedules, not just invariants in isolation.** The dangerous bugs
    require a sequence: pause a render, change a conditional dependency, mount a
    reader, commit another root, settle a promise, or call `flushSync`. This repo
    uses a naive oracle, seeded fuzzing with shrinking, a real-React battery,
    browser tests, fork protocol tests, leak probes, and conformance-gated
    benchmarks because any one layer can be green while the composition tears.

The React fork is intentionally a mechanism boundary. It reports facts React alone
knows—write-batch identity, render start/yield/resume/end, included batches,
per-root commit, retirement, and the mutation window—and offers lane-preserving
scheduling. Signal policy, values, dependency graphs, resources, effects, and
reclamation stay in the library.

## Trends

The week began with core reactivity and data-layout experiments: object links,
arrays, graph-free validation, and packed arenas were compared under one semantic
contract. The important result was not one universal winner. Small microbenchmarks
made arenas look inevitable; full conformant workloads showed that dynamic
retracking, liveness, host boundaries, and VM specialization can dominate memory
layout. That pushed the project toward shape-specific claims, isolated processes,
leak accounting, and correctness gates before performance numbers.

The React work followed the same arc. Early designs tried to reconstruct several
React worlds through large userspace overlays, certificates, logging gates, and
parallel watcher/effect systems. Schedule reviews found missed late dependencies,
wrong-root committed views, equality drops, positional resource aliasing, and
logging that started one write too late. The designs have converged on a smaller
semantic center: replayable operations, frozen render branches, per-root committed
views, real per-world dependency tracking, stable keyed resources, and a thin host
seam that exports facts instead of owning signal policy. Independent Royale
entries and the newer Strata experiment are now testing how small that center can
be rather than adding another interpretation layer.

- **Dead ends:** one mutable external-store head as a transition model; treating
  `useSyncExternalStore` as non-blocking; speculative function versions in durable
  history; positional Suspense caches; quiescence guesses; and certificates or
  clocks asked to replace dependency/dirtiness state they could only guard.
- **Kept:** operation journals, render pins, insertion-order rebase, per-root
  screen state, world-specific dependencies, causal lane delivery, and stable
  thenables.
- **Collapsed or actively collapsing:** separate direct/logged cores, id
  translation tables, duplicated effect dependency snapshots, manager callback
  bags, and policy that can move out of the React fork into one shared userspace
  mechanism.
- **Changed how we decide:** explicit failure schedules, naive executable models,
  cross-implementation batteries, and benchmarks that name graph shape and
  allocation behavior instead of announcing a single fastest library.

## Did you know?

- An alien-signals `Link` measures about **80 bytes** on the tested Node build; a
  stride-8 `Int32Array` record is **32 bytes** and is not traced as an individual
  object—yet the first full arena port was still 14–83% slower on the Kairo
  propagation rows. Locality is not the whole algorithm.
- A microbenchmark allocated 131,000 packed links about **10× faster** than JS
  objects, while shuffled traversal was **9–11×** slower than sequential
  traversal. Tiny layout wins can be real and still fail to predict an app-shaped
  benchmark.
- The graph-free `sweep` design beat alien-signals by **2.3–2.6×** on the CellX
  shapes, then lost by **2.6–6.8×** on wide dynamic graphs because every flush had
  to revisit live-but-unaffected effects.
- Running several libraries in one process can bias a ranking by up to **3×**; one
  measured `cellx1000` case became roughly **9×** slower merely because it ran
  after `sbench`. The harness isolates every framework/suite pair in a child
  process.
- A TypeScript loader's `keepNames` transform added roughly **500 bytes per named
  closure** in one probe and moved `createSignals` from **3.9 ms to 38 ms**. The
  harness bundles every contender the same way so tooling overhead is not mistaken
  for library cost.
