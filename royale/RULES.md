# Signals Royale — tournament rules

You are one of 12 contestants independently rewriting a **concurrent signal library
for React** plus the **React fork** that powers it. The incumbents are
`packages/cosignals-alt-a`, `packages/cosignals-alt-b`, and
`packages/concurrent-solid-react`, all riding one shared 1510-product-line React
fork. Your mission: match their behavior with **radically less code** — and a design
that is recognizably your own.

Your slug is given in your dispatch prompt as `<slug>`. You write exactly two
packages in your own repository clone:

- `packages/signals-royale-<slug>` — your signal engine. React-free, zero runtime
  dependencies, TypeScript source consumed directly (`exports` → `./src/index.ts`).
- `packages/react-signals-royale-<slug>` — everything React: your fork patch series,
  build script, React bindings/hooks, adapters, and React-level tests.

## Objectives, ranked

1. **Minimize React fork size.** Metric: `git diff --numstat <base>..<your-branch>`
   insertions + deletions over `packages/`, excluding `__tests__` files, in your
   React checkout. The incumbent fork measures **1510** on this metric. Internal
   studies estimate ~200–520 lines is achievable without giving up any gate below.
   Zero is allowed if you can pass every gate on stock React (evidence says you
   can't — but proving otherwise wins the objective outright).
2. **Minimize library size.** Metric: non-blank, non-comment lines under both
   packages' `src/` after `prettier --print-width=100` normalization; tests,
   adapters, tools, and docs excluded. Incumbents: alt-a ≈ 4700, alt-b ≈ 5000
   (engine + bindings). Comments are free — never strip documentation to score.
3. **Impressive benchmark performance.** Core: the milomg js-reactivity-benchmark
   (alien-signals parity is the bar the incumbents hover at). React: fanout
   write-to-commit latency, urgent-p95 during large transitions, mount cost.

**Correctness is a gate, not an objective.** Any entry that fails a required gate
ranks below every entry that passes them all, regardless of size. Honesty is also a
gate: your REPORT.md must state exactly what passes and what doesn't; misreporting
disqualifies. Line-golfing (dense one-liners, minified style) is cheating — counts
run after formatter normalization, and unreadable code gets flagged by review.

## Binding owner rulings (not negotiable)

1. **The DOM mutation window is required.** Your fork must emit
   before-mutation/after-mutation edges bracketing exactly React's own DOM mutation
   phase per commit, and your bindings must expose them to userland (a
   MutationObserver client must be able to disconnect while React mutates and
   reconnect after, so it only observes third-party mutations).
2. **Corrective re-renders must land inside the owning batch's commit, never beside
   it.** The incumbent mechanism is `runInBatch` + a transition-lane pin, ruled
   keystone/irreducible. A different mechanism is fine; the observable behavior is
   not.
3. **Never leak.** Leaks are bugs, not optimizations. Dropped handles must be
   reclaimed (FinalizationRegistry-backed by default and/or deterministic disposal).
   Benchmarks must flag leak-vs-no-leak explicitly.

## Required features

Behavioral requirements. Your API surface (classes, callables, free functions) is
your choice — the adapters below map it for verification. Semantics are not
negotiable.

### Core reactive engine

- **Writable signals** with optional custom equality (equal writes drop) and
  optional label. **Lazy initializers**: a function-valued initial state runs once,
  untracked, forbidden from writing, at first materialization (first read, write, or
  subscription — never construction); a `set` before first read still runs it (the
  equality contract needs the base); SSR install does not (install ≠ write).
- **Functional updates that replay**: an `update(fn)` / reducer-dispatch form whose
  function re-executes against each world's base value. The canonical test: signal
  at 1; a transition applies `update(x => x * 2)`; an urgent write applies
  `update(x => x + 1)` and commits immediately showing 2; when the transition
  retires the screen shows 4, not 2 — React updater-queue arithmetic.
- **Computeds**: lazy, cached, equality cutoff, dynamic dependency tracking with
  trimming, exact pull counts (the conformance suite checks all of this). Distinct
  worlds may see distinct dependency sets.
- **Effects and effect scopes** with cleanup, returning disposers. Effects observe
  canonical state only — never speculative transition drafts.
- **batch / startBatch / endBatch** (synchronous coalescing: one flush per scope),
  **untracked**.
- **Lifetime effects (observed lifecycle)**: an atom option
  `effect: (ctx) => cleanup?` that runs when the atom gains its first subscriber of
  *any* kind (computed chain, effect, or React component) and whose cleanup runs when
  the last subscriber of every kind is gone. Exactly one active observation across
  the union of kinds; observe/unobserve flaps within a tick coalesce (microtask
  debounce is fine); StrictMode double-mount nets to one. Use case: wire an atom to a
  socket exactly while something watches.

### Concurrent model (the point of the exercise)

- Writes are classified by which React batch issues them (urgent vs
  transition/deferred). Urgent writes are canonically visible immediately.
  Transition writes stay invisible to canonical readers and to the committed DOM
  until React commits that transition.
- **Render-pass consistency**: a render pass reads one self-consistent world (its
  committed base plus exactly the batches React says it is rendering). Sibling
  components never tear within a commit. Replayed/StrictMode renders see the same
  values.
- **Urgent-during-transition**: commits alone, immediately; the transition later
  lands with its updates rebased on top (see the replay rule above). Rollback of an
  abandoned batch re-notifies anyone who saw it.
- **Per-root committed views**: what is on screen per root, updated at that root's
  commits.
- **flushSync excludes pending deferred work.**
- When React is quiescent, the machinery must cost ~nothing and hold ~nothing: all
  per-episode state reclaimed at quiescence.

### Read family (all five, engine-level)

- canonical read (`.state`-like): committed ∪ applied-urgent; drafts hidden.
- `latest(x)`: newest intent including transition drafts; never suspends; inside a
  computed evaluation or render pass it resolves that context's own world (reading
  ahead of your world is a tear).
- `committed(x, container?)`: what is on screen (per-root when a container is
  given); never subscribes at engine level.
- `isPending(x)`: cheap flip-only probe — true while newer data loads behind stale;
  never refetches, never suspends.
- `refresh(x)`: force refetch with unchanged inputs; stale value keeps serving
  (`latest` preserved — no fallback flash); latest-wins on races; refresh inside a
  transition belongs to that transition.

### Async / Suspense

- Pending and error are **graph state, not control flow**: a computed evaluation
  that touches unresolved thenables evaluates-to-pending; all its async reads
  register before it parks (parallel fetches); downstream evaluations forward
  pending. Errors become reference-stable boxes rethrown at read sites.
- **Thenable identity is stable across Suspense retries** (React re-runs render; a
  fresh promise each time = infinite refetch loop; the battery checks fetch counts).
- **Two-level suspend-vs-stale rule** at React boundaries: inside a transition
  render, hand React the thenable (transition holds); urgent render with a settled
  history serves stale `latest` (no fallback flash; `isPending` is the indicator);
  never-settled suspends everywhere.
- Settlement behaves as a write (invalidate → propagate) and commits with the world
  that owns it.

### React bindings

Required hooks (names may differ; adapter maps them): a subscribing read hook
(`useSignal`-like) that resolves the render pass's world and claims its engine
subscription at commit with post-subscribe fixup; `useComputed(fn, deps)`;
`useSignalEffect` (re-runs on committed-value changes, cleanup honored);
`useCommitted`; `useIsPending`; a transition helper marrying React
`startTransition`/`useTransition` with an engine batch; a component-owned atom hook
(`useAtom`-like, reclaimed after unmount). Registration must fail loudly on a React
build without your protocol. Multiple roots supported. Write-during-render fails
loudly. Unmounted subscribers receive nothing.

### SSR

`serializeAtomState(atoms, replacer?)` / `initializeAtomState(json, atoms, reviver?)`
with app-supplied keys, plus `installState` (does not run lazy initializers, does
not count as a write).

### Causality debug log (new, required)

An attachable tracer answering "why did this happen?":

- Attach/detach at runtime; detached cost ≈ one branch per emit site.
- Events at least: write (with batch attribution), batch open/retire, render pass
  start/end (commit|discard), root commit, component delivery/re-render, effect run,
  suspense settlement.
- Every event carries a causal parent; unrelated operations never chain.
- Queries: the causal chain from a component's latest re-render (or an effect's
  latest run) back to the originating write/retirement; human-readable formatting.
- A bounded-memory ring mode; overflow is counted, never silent.

### React DOM mutation events (new, required)

Userland subscription emitting start/stop around React's DOM-mutation phase per root
commit — exact bracket, not "somewhere near commit" (user effects and passive
effects are outside the window). Test it with a real MutationObserver
(disconnect-on-start / reconnect-on-stop sees zero React mutations while still
catching third-party ones).

## Required verification (run these yourself; all green before you claim done)

| Gate | How |
|---|---|
| Typecheck | `pnpm typecheck` in both packages (tsc --noEmit, strict, extends repo `tsconfig.base.json`). |
| Engine conformance — **179/179** | Depend on `reactive-framework-test-suite@0.0.2` (npm). Copy the ~60-line wiring shape from `harness/conformance/conformance.spec.ts` into your tests. Implement `untracked` so nothing skips. |
| Your own randomized oracle | Write a naive model of YOUR semantics (per-atom write history, memo-free rederivation, world folds) and fuzz your engine against it — the alt-a/alt-b pattern. ≥300 seeds × ~90 steps default, seed count env-tunable, failures print seed + shrunk schedule. Pin found bugs as named regression tests. |
| Real-React gate | Your own vitest suite against YOUR fork build (jsdom per-file pragma, raw `createRoot` + `act` from `react`, `IS_REACT_ACT_ENVIRONMENT = true`, no RTL — repo convention). Must cover the scenario list below. |
| Fork protocol tests | Jest suites inside your React checkout (`yarn test --no-watchman <yourSuites>`) covering your protocol's invariants (the incumbent pinned: exactly-once retirement, pass frames, commit reporting, lane pinning — pin the equivalents for YOUR protocol). Upstream suites adjacent to files you touched must stay green. |
| Leak audit | A GC test (`--expose-gc`, `pool: 'forks'` vitest) proving dropped handles reclaim and quiescence leaves no per-episode state. |

### Real-React gate scenario list (minimum)

1. Urgent write → one commit; batch of writes → one commit.
2. Transition write: pending state never appears in committed DOM; `useIsPending`
   true meanwhile.
3. Urgent write during a live transition: commits alone; transition lands later,
   rebased (the (1+1)×2 = 4 arithmetic).
4. Sibling readers never tear within any commit, including interleaved transitions.
5. Mount mid-transition: new subscriber shows committed value, then joins the
   transition's commit. Suspending variant: the mount reads pending transition state
   and suspends without breaking the held transition.
6. flushSync excludes pending deferred work.
7. One transition batch spanning two roots: per-root consistency.
8. StrictMode: double-mount nets one engine subscription and one lifetime-effect
   observation.
9. Unmount: no further deliveries; subscriptions return to baseline.
10. Write-during-render fails loudly.
11. Suspense first load: fallback → converge, fetch count stays 1 across retries.
    Refetch via `refresh`: stale content + isPending, no fallback flash. Settlement
    inside a transition commits with the transition.
12. Time slicing: urgent input stays responsive while a large transition renders
    (interruption actually happens).
13. Branch state: during a pending transition over shared state, urgent double of a
    counter shows 2 now, 6 after the transition lands (never 4→6 reordering, never
    a torn 3).
14. Lifetime effect: first render subscriber mounts the observation, last unmount
    cleans it up.
15. Causality: after scenario 3, the trace explains the component's re-renders —
    urgent chain to the urgent write, post-retirement chain to the transition write.
16. Mutation window: the MutationObserver use case above.
17. Lazy initializer: initializer runs at first render read; set-before-read runs it
    first.
18. SSR: serialize → `installState` on a fresh engine → first client render matches
    with zero corrective re-renders.

## Deliverables manifest

```
packages/signals-royale-<slug>/
  package.json            # name signals-royale-<slug>, exports -> ./src/index.ts, zero deps
  tsconfig.json           # extends ../../tsconfig.base.json
  vitest.config.ts        # pool 'forks', execArgv ['--expose-gc']
  src/                    # engine (React-free)
  tests/                  # conformance.spec.ts, oracle fuzz + pinned regressions, engine specs, gc-leaks
  royale/harness-adapter.ts   # FrameworkAdapter (interface below)
  royale/milomg-adapter.ts    # ReactiveFramework (interface below)
  README.md               # npm-standalone voice (see house style)

packages/react-signals-royale-<slug>/
  package.json            # react/react-dom via link: into ../../vendor/react/build/oss-experimental/*
  patches/                # git format-patch series vs the base commit (regenerable; see workflow)
  build.sh                # pristine checkout + apply patches + build (may wrap fork/build-react.sh)
  src/                    # bindings, hooks, tracer surface, mutation-window surface
  tests/                  # real-React gate + feature specs
  royale/adapter.ts       # RoyaleAdapter (interface below) — exact member names matter
  royale/seam-bench-adapter.ts
  royale/daishi-adapter.tsx
  README.md + REPORT.md   # REPORT: gates table w/ real output, LOC self-count, design summary, known gaps
```

## Your React fork workflow

Your environment is pre-provisioned (see your dispatch prompt for the path):

- Your repo clone has a branch `royale/<slug>` checked out.
- `vendor/react/` inside it is a **full local clone** of the React repo, checked out
  at the pinned upstream base `e71a6393e66b0d2add46ba2b2c5db563a0563828`
  (= npm `19.3.0-canary-e71a6393-20260702`) on branch `royale/<slug>-react`, with
  `node_modules` already populated.
- Build: `./fork/build-react.sh` from your clone root (~13s; artifacts →
  `vendor/react/build/oss-experimental/{react,react-dom,scheduler}`; consumed via
  `link:` so rebuilds need no reinstall).
- Fork tests: `cd vendor/react && yarn test --no-watchman <pattern>`.
- Commit your fork work on `royale/<slug>-react` INSIDE vendor/react; regenerate
  `patches/` in your react package with
  `git -C vendor/react format-patch -o ../packages/react-signals-royale-<slug>/patches e71a6393e6..HEAD`.
- Measure yourself:
  `git -C vendor/react diff --numstat e71a6393e6..HEAD -- packages/ ':!packages/*/src/__tests__*' | awk '{a+=$1+$2} END {print a}'`.
- Keep fork files clean under React's own prettier config (`yarn prettier` in
  vendor/react); raw diff lines are what's counted.

Package installs: `pnpm install --ignore-workspace` inside each of your two package
dirs (pnpm 10.33, node 24; the store is warm). Never run `pnpm install` at the clone
root. Superproject commits: commit early and often on `royale/<slug>`; touch ONLY
your two package dirs (plus the vendor/react gitlink if git insists).

## Isolation rules

- Work only inside your assigned clone.
- **Never look at other contestants' work** (`*royale*` packages anywhere outside
  your clone, including the orchestrator repo at
  `/Users/jitl/src/alien-signals-opt`).
- **Forbidden reading** (design-independence — the whole point is a fresh design):
  `packages/cosignals*/src/**`, `packages/concurrent-solid-react/src/**`, `spec/`,
  `design-loop/`, `monitor-design/`, `research/`, `reviews/`, `plans/`,
  `react-concurrent-signals-arena*.md`, and the incumbents' SPEC-RESOLUTIONS.md.
- **Allowed reading**: this file; every `tests/` / `test/` dir (tests define
  behavior); package READMEs; `harness/**`; `fork/README.md` and
  `fork/build-react.sh`; `packages/react-seam-bench/**`;
  `packages/cosignals-react/tests/**`; your React checkout (all of upstream React,
  plus `git log`/`git diff` of the incumbent fork branch if present in your clone —
  knowing the incumbent seam is fair; copying its engine is not).

## House style (owner's standing rules)

- Docs are npm-standalone: no research jargon, no §-references, no internal
  codenames; explain concepts from scratch; self-contained reasoning.
- Say "create", never "mint" — prose, comments, identifiers.
- Comments state engineering rationale (why the design is right), never benchmark
  rationale ("this made X 5% faster") and never review-notes ("this is correct
  because").
- Named number types (type aliases for ids/tokens); one name per concept; const
  enums only within a single file (esbuild).
- No `Date.now`/`Math.random` in hot paths. TS source is the artifact — no build
  step for the engine package.

## Verification adapter interfaces (verbatim targets)

### FrameworkAdapter (harness conformance; `royale/harness-adapter.ts`)

```ts
export interface AdapterSignal<T> { read(): T; write(value: T): void }
export interface AdapterComputed<T> { read(): T }
export interface FrameworkAdapter {
  name: string; // "signals-royale-<slug>"
  signal<T>(initialValue: T): AdapterSignal<T>;
  computed<T>(fn: () => T): AdapterComputed<T>;
  effect(fn: () => void | (() => void)): () => void;
  effectScope(fn: () => void): () => void;
  startBatch(): void; endBatch(): void;
  untracked<T>(fn: () => T): T; // implement it — skips are lost points
}
```

### ReactiveFramework (milomg; `royale/milomg-adapter.ts`)

```ts
export interface ReactiveFramework<S = unknown> {
  name: string; // "Royale <SLUG>"
  createSignal(initialValue: unknown): S;
  readSignal(signal: S): unknown;
  writeSignal(signal: S, value: unknown): void;
  createComputed(fn: () => unknown): S;
  readComputed(cell: S): unknown;
  effect(fn: () => void): void; // fn returns undefined by contract
  withBatch(fn: () => void): void;
  withBuild<T>(fn: () => T): T; // build inside a scope…
  cleanup(): void;              // …and dispose it here (no leaks in the bench!)
}
```

### Contender (react-seam-bench; `royale/seam-bench-adapter.ts`)

```ts
import type { ComponentType, ReactNode } from 'react';
export interface CellStore {
  useCell(i: number): number;
  writeCell(i: number, v: number): void;
  writeMany(updates: Array<[number, number]>): void;
  writeManyInTransition(updates: Array<[number, number]>): void;
  dispose(): void;
  Provider?: ComponentType<{ children: ReactNode }>;
}
export interface Contender {
  name: string; // "royale-<slug>"
  createCells(n: number): CellStore;
}
// default-export the Contender; module load may register your runtime.
```

### Daishi tearing matrix (`royale/daishi-adapter.tsx`)

```ts
// default-export three hooks over one module-level store holding a counter that
// starts at 0. Module load performs any registration needed.
export default {
  useCount(): number,        // subscribes
  useIncrement(): () => void, // stable callback: count += 1
  useDouble(): () => void,    // stable callback: count *= 2
};
```

### RoyaleAdapter (the shared cross-entrant battery; `royale/adapter.ts`)

```ts
export interface RoyaleHandle { dispose(): void }
export interface RoyaleTraceView {
  /** Formatted causal chain from the most recent component delivery caused by
   * this signal/computed, back to its originating write or retirement. */
  whyLastDelivery(x: unknown): string[];
  events(): Array<{ id: number; kind: string; cause?: number; error?: unknown }>;
  dropped(): number;
  stop(): void;
}
export interface RoyaleAdapter {
  slug: string;
  // Modules from YOUR react build — the battery never imports 'react' itself.
  React: any;
  ReactDOMClient: { createRoot(el: Element): { render(node: unknown): void; unmount(): void } };
  act<T>(fn: () => T | Promise<T>): Promise<undefined>;
  flushSync(fn: () => void): void;
  // Lifecycle
  register(): RoyaleHandle;   // idempotent per process
  resetForTest(): void;       // engine reset + host registry scrub
  // Engine
  atom<T>(initial: T | (() => T), opts?: {
    equals?(a: T, b: T): boolean;
    onObserved?(ctx: { get(): T; set(v: T): void }): void | (() => void);
    label?: string;
  }): unknown;
  set(a: unknown, v: unknown): void;
  update(a: unknown, fn: (prev: unknown) => unknown): void;
  computed<T>(fn: (use: <U>(t: PromiseLike<U>) => U) => T,
              opts?: { equals?(a: T, b: T): boolean; label?: string }): unknown;
  read(x: unknown): unknown;
  latest(x: unknown): unknown;
  committed(x: unknown, container?: unknown): unknown;
  isPending(x: unknown): boolean;
  refresh(x: unknown): void;
  effect(fn: () => void | (() => void)): () => void;
  batch(fn: () => void): void;
  untracked<T>(fn: () => T): T;
  serialize(atoms: unknown[]): string;
  initialize(json: string, atoms: unknown[]): void;
  // React surface
  useValue(x: unknown): unknown;
  useComputed<T>(fn: () => T, deps: unknown[]): T;
  useSignalEffect(fn: () => void | (() => void)): void;
  useIsPending(x: unknown): boolean;
  useCommitted(x: unknown): unknown;
  startTransitionWrite(scope: () => void): void;
  // Royale features
  trace(): RoyaleTraceView;                  // starts tracing
  onDomMutation(cb: (phase: 'start' | 'stop', container: Element) => void): () => void;
}
```

## Report format

`REPORT.md` in the react package, and the same content as your final message:

1. Design summary (≤10 sentences): the one idea that makes your entry different.
2. Gates table: each required gate, the exact command, pass/fail, headline numbers
   (test counts, seeds, fork-suite counts). Paste real output snippets.
3. LOC self-count: fork metric + library metric, with the commands you ran.
4. Feature coverage: each required feature — done / partial / missing, one line each.
5. Known gaps and honest risks.
6. What you'd do with another day.

Good luck. Build something the incumbents will want to steal from.

## Erratum (2026-07-08, adjudicated during judgement)

The functional-update replay example in "Required features" and the scenario-list
form are mutually unsatisfiable by any single fixed replay order (credit: entry sm1
demonstrated this). The BINDING semantics, pre-ruled at battery calibration and
verified against the incumbents, are React updater-queue parity: every update to an
atom folds in original dispatch order; urgent updates apply canonically at once;
retirement replays the full interleaved queue in dispatch order. The battery's
scenario tests encode this form and take precedence over the prose example.
