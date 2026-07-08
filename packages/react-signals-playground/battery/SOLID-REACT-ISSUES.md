# concurrent-solid-react: issues found by the browser battery

Handoff document, written 2026-07-08. Audience: an agent working on
`packages/concurrent-solid-react` (a Solid 2.0 reactive core hosted inside
React through a bridge) with no other context about this repository.

## Resolution status (updated 2026-07-08, later the same day)

All five issues are resolved in `packages/concurrent-solid-react`; the
playground shim runs real Solid memos again and the battery rows flipped
(expectations.ts + MANIFEST.md updated). Summary:

1. **Heap lockup** — no longer reproducible after unrelated engine fixes, and
   the class is now structurally impossible: the render probe reads under the
   mid-recompute flag every heap-insertion path skips, so it can never be
   parked in the dirty heap (probe hardening in `src/reader.ts`; regression
   pin `test/wedge-repro.test.tsx` — hangs pre-fix).
2. **Torn mounted frames** — fixed by per-render-pass value pinning: the
   bridge pins each node's first-read value for the pass's lifetime, and the
   commit-time fixup corrects staleness pre-paint. Verified: the DAISHI-2
   drive records zero torn frames in both latches.
3. **Render-phase writes** — now rejected (throw) by the bridge whenever
   React render is on the callstack; engine-internal render-read work stays
   exempt. Package test added.
4. **Effects held by unrelated transitions** — changed: tracked-effect
   delivery is split by world. Urgent commits run effects immediately
   (committed values); a transition's own pokes hold a forced re-run released
   at that batch's commit. Effects still never observe drafts. Package tests
   added; the battery's variant row now asserts the standard behavior.
5. **Outside-render reads** — ruled and documented (package README, "Which
   world does a read see?"): committed-only, with the same-scope case fixed —
   a startTransition callback reads its own staged writes back. Package test
   added; RCC-RT1.scope-read now takes the standard branch.

The "resolved since last documented" thenable-freeze item was already pinned
by the package gate ("held transition leaves committed state on screen;
urgent writes rebase on top" in `test/react-real.test.tsx` drives urgent
commits through a promise-held transition).

Where the evidence lives:

- The app: `packages/react-signals-playground` — one React app that runs
  against four signals implementations; the `/solid-react/` page runs yours.
  Adding `?test=1` to any page URL enables test instrumentation: a
  `window.__store` API and extra probe components (documented in
  `packages/react-signals-playground/battery/TESTIDS.md`).
- The battery: `packages/react-signals-playground/battery/` — a Playwright
  suite that drives the app in a real bundled Chromium. Every issue below
  names its battery test; test ids like `RCC-*`, `DAISHI-*`, `FIND-*` are
  just test names (they cite an internal spec's clause numbers — you do not
  need that spec to act on this document).
- React here is the workspace's patched build (`vendor/react`, wired via the
  root `pnpm.overrides`); the bridge requires it. None of the issues below
  depend on the patch beyond that.

How to run the evidence:

```sh
cd packages/react-signals-playground
npx playwright install chromium              # once per machine
pnpm battery --project=solid-react           # everything for this package
pnpm battery --project=solid-react -g DAISHI-2   # one issue's pinned test
```

Tests annotated "expected to fail" are the open issues below, pinned so they
stay visible. When you fix one, the battery goes red on that row with
"Expected to fail, but passed" — that is the signal to flip its entry in
`battery/expectations.ts` and its row in `battery/MANIFEST.md`.

One load-bearing piece of context: the playground's adapter for your package
(`packages/react-signals-playground/src/shims/solid-react.ts`) currently
works around issue 1 by NOT using Solid memos — derived values recompute
inline on every read through `useSelector`. Issues 2–5 were found under that
configuration; re-test them after fixing issue 1 with real memos restored.

---

## Issue 1 — CRITICAL: main-thread lockup on an urgent write with a memo-subscribed component

- Symptom: with any React component subscribed to a Solid memo through the
  bridge, one signal write OUTSIDE any transition locks the page — the
  engine's flush loop spins forever at 100% CPU.
- Prior diagnosis (recorded in the playground adapter's comments): the
  bridge's shared render-probe node ends up parked in the engine's
  dirty-node heap with its status flags cleared; the heap's remove-guard
  then skips it, and the flush loop can never drain that level.
- Why the package's own tests pass: they always write inside transitions or
  without memo-subscribed components. The trigger is a plain urgent write
  with no transition open.
- Repro: in `src/shims/solid-react.ts`, revert `createComputed` and
  `useComputed` to real Solid memos (the comment block on `createComputed`
  explains the current degraded form), rebuild, open `/solid-react/`, click
  the "+1 urgent" button once. The page wedges.
- Battery pin: `FIND-SOLID-HEAP` — green today because of the workaround; it
  exists so a regression to wedging is caught (the harness interrupts the
  spinning main thread over the Chrome DevTools Protocol and attaches the
  live stack to the report).
- Fix wanted: memos safe under urgent writes, so the playground can remove
  the degradation (which costs recomputation on every read).

## Issue 2 — CRITICAL correctness: torn painted frame when components mount inside a transition under urgent writes

- Symptom: mount ~20 components that each read the same signal, inside
  `startTransition`, while a timer writes that signal urgently every 50 ms.
  The commit that reveals the new components paints them with DIFFERENT
  values — one observed frame showed readers at 2, 3, 4, 5, 6 while an
  already-mounted reader of the same signal showed 2.
- Why it matters: React's concurrent-rendering contract is that one
  committed frame shows one consistent snapshot of external state. This is
  exactly the tearing that `useSyncExternalStore`-style adapters exhibit and
  that this bridge exists to prevent. The update path is clean — only
  MOUNTING components tear.
- Failure shape: values increase monotonically across the reader list,
  consistent with each component resolving the CURRENT committed value at
  the moment its own render slice ran, instead of one snapshot fixed for the
  whole interruptible render pass. The bridge's post-commit read-compare
  fixup either does not cover first-mount reads or runs too late: the torn
  frame survives to paint (it is caught by a passive `useEffect` check, not
  only by a pre-paint `useLayoutEffect` check).
- Repro: battery `DAISHI-2/DAISHI-4` (and the `useDeferredValue` variant
  `DAISHI-8/DAISHI-10`) on project solid-react — currently expected-fail;
  the exact steps are in `battery/specs/h1-daishi.spec.ts`. Manually:
  open `/solid-react/?test=1`, run
  `__store.startAutoIncrement(50, 'urgent'); __store.setLatticeWork(10)` in
  the console, click the "lattice plain" button, then inspect
  `__store.lattice.tornPassive` — each entry is one torn committed frame
  with every reader's painted value.
- Caveat: reproduced with the unmemoized-derived workaround in place
  (readers subscribe via `useSelector(() => signal())`). Re-test with real
  memos after issue 1.
- Fix wanted: components mounting inside a transition read the same
  snapshot as every other component in that render pass.

## Issue 3 — Render-phase writes are accepted silently

- Symptom: calling a signal setter during a component's render body
  succeeds — no throw, no dev warning — and the write becomes permanent
  state.
- Why it matters: React renders speculatively and re-runs renders freely; a
  write issued from render can execute any number of times, including from
  renders whose output is discarded. React's own rule is that rendering must
  be pure. The three other implementations in this comparison throw an
  error for this case.
- Repro: battery `RCC-UM2.render-write` on project solid-react
  (expected-fail). Manually: `/solid-react/?test=1`, click the
  "render-write probe" button; the outcome element shows
  `wrote-without-error` (the other implementations show `rejected: <error>`).
- Fix wanted: reject render-phase setter calls (throw), or at minimum warn
  in development builds.

## Issue 4 — Effects for urgent commits are held while any transition is pending (confirm or fix)

- Symptom: while a transition is held open (for example suspended on data),
  an unrelated urgent write commits and paints — but tracked effects
  (`createTrackedEffect` / the package's `useSignalEffect`) do not run for
  it. They run only when the transition finally commits, observing the final
  value.
- Assessment: this looks intentional (effects hold while a transition is
  live, release at its commit), and the good half is real — effects never
  observe a pending transition's values. But the deferral is unbounded: a
  long-held transition delays urgent-commit effects (DOM sync, analytics,
  imperative subscriptions) indefinitely. The comparison implementations run
  effects at every commit that changes committed state.
- Repro: battery `RCC-EF1.count-hold` (asserted as a solid-react variant, so
  it is green — it pins today's behavior). Manually: hold a transition
  open, click "+1 urgent" (the counter paints), and observe no effect run
  until release.
- Ask: confirm this is intended and document it in the package README, or
  change it. Either way, add a package test.

## Issue 5 — Outside-render reads never see pending transition writes; the semantics are unpinned (needs a ruling + tests)

- Behavior: after `startTransition(() => setSignal(10))`, reading the signal
  from an event handler, a timer, a promise continuation — or even LATER
  INSIDE THE SAME transition callback — returns the old committed value
  until the transition commits. A bare accessor call (no Solid owner
  context) always resolves committed state; only the documented
  `runWithOwner` re-entry idiom resolves the staged value.
- Assessment: committed-only reads outside rendering are a defensible
  design — two of the four implementations here rule that way deliberately.
  Two problems remain: (a) nothing in the package's tests or README states
  the rule, so it is an accident of implementation rather than a contract;
  (b) the same-scope case is surprising — code that writes a signal and
  reads it back within one transition callback gets the OLD value, which
  diverges from every other implementation (they see their own in-scope
  write).
- Repro: battery `RCC-RT1.scope-read` and `RCC-RT4-drafts-hidden` on project
  solid-react (both green — they pin today's behavior). Manually:
  `/solid-react/?test=1`, run
  `__store.transitionScopeProbe('storeOnly', 41)` — returns
  `{ inScope: 0, ambient: 0 }` (the write itself does commit later).
- Ask: decide the intended semantics, write them down, and add package
  tests. If in-scope reads should see the scope's own write, fix that case
  specifically.

## Resolved since last documented — no action, but worth a regression test

A promise thrown from a component inside a transition render used to freeze
ALL commits (urgent ones included) until it resolved, after which React
recovered with a synchronous root render. Retested 2026-07-08 against
current sources: not reproducible — thrown promises (native Promise or bare
thenable object) now hold the transition open exactly like the other
implementations, with urgent commits landing throughout. The battery pins
the working behavior (`FIND-THENABLE.gate`); the package itself has no test
for it. Consider adding one so the freeze cannot return silently.
