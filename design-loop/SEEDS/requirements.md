# Requirements (frozen seed)

What the product is: a from-scratch TypeScript signals library with
no-compromise concurrent React integration (no `useSyncExternalStore`), backed
by a React fork we fully control. These requirements are the contract; the
architecture is the design space.

## R — Functional (the user-facing chrome; largely settled by prior work)

- **R1 Atom**: `new Atom<T>({ state, effect?, isEqual?, label? })`;
  `atom.state` (tracked read), `set(v)`, `update(fn)`. `effect` runs on
  observed 0→1 with cleanup on 1→0, microtask-debounced (flap-proof).
- **R2 Computed**: `new Computed<T>({ fn(ctx), isEqual?, label? })`; lazy,
  cached, exact re-verification; `ctx.use(thenable)` suspense with per-world
  positional identity; `ctx.previous`. Errors/suspensions are cached values
  (sentinel boxes) — a throwing getter can never corrupt graph state.
- **R3 ReducerAtom**: `dispatch(action)`; actions are logged and replayed per
  world; parity with `useReducer` is a conformance test, not a hope.
- **R4 Hooks** (`cosignal/react`): `useSignal`, `useAtom`, `useReducerAtom`,
  `useComputed(fn, deps, opts?)` (closes over props/state; signal reads
  auto-tracked), `useSignalEffect(fn, deps?)` (committed state only). No
  provider component. Multiple roots.
- **R5 Transitions**: full `startTransition`/`useTransition` parity — signal
  and React state move in lockstep; optional `startSignalTransition` /
  `useSignalTransition` throughput helpers.
- **R6 Suspense parity**, including the mount-mid-transition-while-suspending
  case (react-concurrent-store's documented known bug must be a passing test),
  and fresh nodes (`useComputed` mounted mid-transition) reading the pass's
  world correctly on first render.
- **R7 Infinite-loop rejection**: React's own limits for React-coupled storms;
  engine cycle detection for signal-only loops.
- **R8 Writes inside computeds**: tolerated when acyclic;
  `configure({forbidWritesInComputeds})`; render-world evaluation always
  rejects writes.
- **R9 Multiple roots** including batches spanning roots (per-root commit
  lock-in; per-root committed views for effects).
- **R10 SSR/hydration** from serialized atom state (RSC/Flight out of scope v1).
- **R11 Tracing**: lazily-loadable, zero-allocation recorder (ring + lossless
  session modes), causality queries, Graphviz renderers; untraced cost = one
  slot check per site. (The synthesized spec §16 is the reference bar; reuse
  it unless the architecture forces changes.)
- **R12 React fork**: see `fork-charter.md` — the old "minimal additive patch"
  constraint is lifted; maintainability is a scored axis instead.
- **R13 Core non-React API**: `effect()`, `effectScope()`, `batch()`,
  `untracked()`, `configure()`; benchmark contracts (synchronous flush outside
  batch, fresh mid-batch reads).

## P — Performance (gates, not adjectives)

- **P1** Signal-driven re-render within 10% of equivalent `useState`;
  10k-subscription mount within 15%.
- **P2** Pure-core (no React) at-or-below alien-signals v3 on every tier-0
  shape; exact pull counts (`testPullCounts: true`); 179/179 conformance
  including growth stress. Donor reference points in `research-facts.md`.
- **P3** Concurrency machinery costs ~nothing when inactive: pure-core users
  execute zero concurrency instructions; React-mounted-but-quiet ≤2% on
  tier-0; every hot mechanism carries a numeric gate and a CI check (the
  synthesized spec's §18 gate-table style is the bar).
- **P4** Zero engine allocation on steady re-render traffic; memory wins
  reported as heapUsed + plane bytes side by side.

## E — Engineering

- pnpm workspaces; TypeScript; `type` over `interface`; `undefined` over
  `null` (each `null` justified); ships compiled JS (same-file `const enum`
  allowed per the measured bundler-demotion hazard); branded id types;
  `__DEV__` by define, never by runtime const.
- Process apparatus is inherited, not redesigned: oracle-first sequencing,
  frozen-kernel contract suite, bytecode budgets CI, pre-registered
  experiments, per-milestone numeric exit gates. (These survived review;
  spend design tokens elsewhere.)
- Plain-spoken spec: every concept defined in plain English before use; the
  concurrency story must fit on one page (judged).

## Non-negotiable correctness bar

Every case in `correctness-cases.md`, walked mechanism-by-mechanism.
`useState`/`useReducer`/`startTransition` parity is the product.
