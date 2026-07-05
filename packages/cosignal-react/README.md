# cosignal-react

React bindings for `cosignal`'s LOGGED engine, driven by the cosignal
React fork's external-runtime seam. This is the layer where signals
become concurrent-React-correct: pending transitions see their own
world, committed truth never tears, and the react-concurrent-store
known bug (a mid-transition mount of a suspending pending read) is
fixed — pinned by scenario test R6.

## Requirements

React must be the cosignal fork (`vendor/react`, branch `cosignal-fork`)
built via `fork/build-react.sh`; the workspace's pnpm overrides link
`react`/`react-dom`/`scheduler` to the built artifacts. The bindings
verify the versioned handshake at startup:
`React.unstable_externalRuntimeProtocol` must report protocol v1 with
all v1 capability bits (511). A stale or stock React build fails loudly
(fork error codes 602/603).

## Surface

- `registerCosignalReact()` — arms the bridge and subscribes to the
  fork's external-runtime events (pass start/yield/resume/end with
  dispositions, per-root commits with generations, batch retirements,
  the mutation window). Call once at app startup, before the first
  render.
- `useSignal(atom)` — subscribe a component to an atom in its rendered
  world; publication and the §5.10 mount fixup (fast-out conjuncts,
  corrective loop, urgent pre-paint correction) run in a layout effect.
- `useComputed(fn, deps)` — derived value with useMemo semantics: the
  node is recreated when deps change (ratified cut C3). `ctx.previous`
  is a committed-value hint (cut C4); `ctx.use` provides Suspense
  capsules.
- `useReducerAtom(atom)` — `[value, dispatch]`, useReducer parity.
- `useSignalEffect(fn)` — effects over committed-for-root truth with
  the §5.11 flush triggers (every root commit and per-root advance,
  retirements, settlement re-checks), fingerprint-validated.
- `startSignalTransition(scope)` — transition/async-action integration
  (ActionScope): writes inside the synchronous prefix join the parked
  batch; post-await writes are ambient unless re-wrapped — exactly
  React's own transition contract (cut C1).

Library writes are classified by the fork's write-context API into
ambient default, discrete urgent, transition, or action batches;
deliveries and corrective updates ride `unstable_runInBatch` so they
land in the right lanes.

## Tests

`pnpm -C packages/cosignal-react test` — 45 tests: hook behavior
(StrictMode, deps-keyed recreation, op-replay fidelity), 14 concurrency
scenarios (R1–R14, including the R6 known-bug fix), the spec's 17-case
correctness battery at React level (non-exercisable rows are documented
in the spec files and pinned at engine/fork level instead), and a
tracer smoke test. The suite runs against the real fork build via
jsdom + `react-dom/client`.
