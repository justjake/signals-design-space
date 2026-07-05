The plan is not landable as written. I found ten blockers, including failures in every substantive phase.

### 1. An ordinary receipt cannot behave like React render-phase state

**BLOCKER — Phase 1 / Phase 3**

Schedule:

1. Stable node `N` is committed with function `F0`; an existing watcher subscribes to `N`.
2. Pass `P` starts at sequence `s`.
3. During `P`, `fnAtom.set(F1)` appends a receipt at `s + 1`.
4. The pass world excludes that receipt because pass visibility is explicitly capped at `seq <= pin` ([visibility rule](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1157), [pass pin](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:2151)). `P` therefore derives new props using `F0`, exactly the incoherent frame Phase 1 says the write prevents.
5. The normal write path also eagerly updates newest state and synchronously walks deliveries ([write path](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:2024)). The shim translates those deliveries immediately after the operation ([withBridge](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:521)), but the host’s `runInBatch` explicitly throws during render ([host contract](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:964)).

Suppressing delivery leaves memoized consumers stale; allowing it throws; making the receipt visible breaks the frozen-pass invariant. Any special render-local visibility/delivery queue is a second versioning channel omitted by the “[exact machinery](\/Users/jitl/src/alien-signals-opt/plans/2026-07-05-one-core-convergence.md:79)” claim.

**React parity — both over and under:** React only permits a setter belonging to the currently rendering component, discards that output, and immediately retries before rendering children. It does not publish a mutation to an external newest-state graph. The plan grants broader external mutation while omitting the immediate local retry guaranteed by [`useState`](https://react.dev/reference/react/useState#set-functions-like-setsomethingnextstate). It also violates React’s general prohibition on nonlocal render side effects ([render purity](https://react.dev/reference/rules/components-and-hooks-must-be-pure#side-effects-must-run-outside-of-render)).

### 2. Phase 0 routes ordinary event reads through completed speculative renders

**BLOCKER — Phase 0 / Phase 3**

The in-flight implementation arms one global ambient pass world at pass start and clears it only on yield or pass end ([shim](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:382)). React emits no yield when a tree completes but waits to commit ([work loop](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:2970)); its protocol explicitly says that the frame remains open while `getRenderContext()` is null and that treating `[start,end)` as “in render” is wrong ([protocol](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react/src/ReactExternalRuntime.js:130)).

Schedule:

1. Transition pass `P` pins `a = 10`, completes, and waits to commit.
2. Urgent batch `U` writes `a = 1` after `P`’s pin.
3. A timer runs outside render. React reports no render context, but raw `a.state` is routed through `P`’s frozen ambient world and returns `10`.
4. `a.set(a.state + 1)` writes `11`; a correct outside-render newest read would have produced `2`.

With two completed roots, whichever pass most recently set the single ambient field wins, so an event can even read another root’s world. This undershoots the host’s documented call-stack contract.

### 3. “Host hook first” already breaks the core’s purity and strictness contracts

**BLOCKER — Phase 0**

The plan explicitly keeps updater/reducer purity and `forbidWritesInComputeds` ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-05-one-core-convergence.md:41)), but public methods invoke `hostWrite` before either policy ([Atom methods](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:1817)).

Two concrete failures:

- For a registered atom, `a.update(() => b.state + 1)` is intercepted before `runFold` installs the `POISON` engine. During replay the bridge marks its own `inFoldCallback`, but with no active world `b.state` falls directly through to the kernel read. The read succeeds even though the documented API says updater reads throw ([README](/Users/jitl/src/alien-signals-opt/packages/cosignal/README.md:84)).
- With `forbidWritesInComputeds: true`, a kernel `Computed` writing a registered atom first appends the host receipt, then the bridge re-enters `Atom.set` to update the kernel. Only that second call reaches the strictness check ([policy check](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:1450)). It throws after the receipt has already landed ([receipt append](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:2024)), leaving mutation behind despite the failed call.

Thus the empty-host branch cannot literally be the first semantic test without duplicating all core policy in the host path.

### 4. There is no “rendering pass’s batch,” and the host cannot check the owner

**BLOCKER — Phase 1 / Phase 3**

A pass contains `includedBatches`, plural. During render, `getCurrentWriteBatch()` merely picks an arbitrary lane from the complete render-lane set ([implementation](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:912)). It does not identify which batch caused the current component’s function version.

Schedule:

1. Pass `P` includes batches `A` and `B`; `B` supplies the props that produce closure `FB`.
2. The arbitrary picker returns `A`, so the function receipt is stored in `A`.
3. `P` is discarded. A restart renders a different batch set containing `A` but not `B`.
4. That world now folds `FB` although the React props represented by `B` are absent.

The receipt format can express membership in one token, not “this version exists only when this whole pass lineage/batch set exists.”

Ownership is independently unimplementable from the stated host surface: `getRenderContext()` exposes only `{container}` ([provider surface](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react/src/ReactExternalRuntime.js:204)), not the current Fiber or hook owner. A root/pass-level check would legalize sibling or general user writes, exceeding React’s documented current-component-only rule; rejecting them cannot be done from the available identity.

### 5. An UPDATE fiber can die while its function receipt survives

**BLOCKER — Phase 1**

Schedule:

1. Component `C` has committed stable node `N/F0`; some event handler retains the public handle.
2. Live transition batch `K` starts update pass `P`; `P` writes `F1` into `K`, then suspends.
3. `discardAllWip()` discards the WIP Fiber but deliberately reschedules the abandoned lanes and leaves `K` live ([React fork](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react-reconciler/src/ReactFiberWorkLoop.js:1031)).
4. Bridge discard removes pass-owned mounts, not receipts belonging to `K` ([pass discard](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:2341)).
5. Before the retry reaches `C`, the retained handle is read outside render. Newest-state evaluation includes every live receipt and therefore executes `F1`, even though no React Fiber accepted that render.

This directly falsifies “discard drops the version with the batch”: the Fiber was discarded, but the batch was not. React’s own render-phase queues are cleared on unwind ([hooks implementation](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react-reconciler/src/ReactFiberHooks.js:939)), with a dedicated suspension regression test ([React test](/Users/jitl/src/alien-signals-opt/vendor/react/packages/react-reconciler/src/__tests__/ReactHooksWithNoopRenderer-test.js:621)). Retaining `F1` exceeds React’s state lifetime.

### 6. The deps-equality cutoff is invalid once any receipt exists

**BLOCKER — Phase 1**

The engine and oracle both enforce the opposite rule: equality may drop a write only when the tape is empty, because newest equality proves nothing about another world ([engine](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:2001), [oracle](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/model.ts:696)).

Counterexample:

1. Base function state is `X/F0`.
2. Batch `A` writes `Y/FA`.
3. Batch `B` writes `X/FB`; newest state is now `X`.
4. Pass `P` includes `A` and a new batch `C`, but excludes `B`. React props from `C` require `X/FC`.
5. The proposed cutoff compares `C`’s `X` against newest `B`’s `X` and drops the write before minting.
6. `P` folds its actual set `{A,C}`. Since `C` has no receipt, it ends at `Y/FA`.

Thus the promised free replay causes precisely the cross-world function leak the atom design claims to prevent.

### 7. Phase 2’s “one implementation” is both unreachable and incorrectly scoped

**BLOCKER — Phase 2**

Current React computeds are overlay `ComputedNode`s wrapped by `BoundComputed` ([hooks](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/hooks.ts:67)). Core `ctx.use` discovers its owner through the kernel’s active subscriber and rejects anything that is not an actual kernel `Computed` ([ctx.use](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/index.ts:1553)). The overlay deliberately does not use kernel computeds because dependency-flipping evaluations have already produced stale-link cycles and disposal hangs ([logged engine](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:1235)). Therefore capsule deletion leaves no callable base implementation unless Phase 2 reintroduces a known hang or creates another adapter.

Even if connected, one node-wide slot is wrong across worlds:

1. Committed world evaluates `q1`; slot 0 contains settled `P1`.
2. A transition evaluates `q2`, replaces it with pending `P2`.
3. An unrelated urgent committed dependency invalidates the same stable node while committed state is still `q1`.
4. Core `ctx.use(() => fetch(q1))` sees pending `P2`, skips the factory, and suspends the committed world on `q2`.

The current tests explicitly pin “pending previous wins” and “factory skipped” ([tests](/Users/jitl/src/alien-signals-opt/packages/cosignal/tests/suspense.spec.ts:102)). React’s contract is reuse for the same resource key—its example returns the same promise for the same URL—not one pending promise across different inputs ([React `use`](https://react.dev/reference/react/use#caching-promises-for-client-components)). This over-deduplicates across keys and undershoots correct per-key behavior.

### 8. The verification story is internally impossible

**BLOCKER — Phases 0–2 / sequencing**

The plan simultaneously says:

- every semantic change is modeled in the oracle first ([principle](/Users/jitl/src/alien-signals-opt/plans/2026-07-05-one-core-convergence.md:35));
- Phase 1 first models render-phase writes in that oracle ([Phase 1](/Users/jitl/src/alien-signals-opt/plans/2026-07-05-one-core-convergence.md:96));
- the oracle package is untouchable throughout ([sequencing](/Users/jitl/src/alien-signals-opt/plans/2026-07-05-one-core-convergence.md:141)).

Today the oracle expressly requires every render write to throw ([test](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/tests/battery.spec.ts:780)), its generated schedule has no render-write/function-version operation ([schedule grammar](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/src/schedule.ts:37)), and Suspense is deliberately skipped ([oracle test](/Users/jitl/src/alien-signals-opt/packages/cosignal-oracle/tests/battery.spec.ts:797)). It therefore cannot referee either Phase 1 or Phase 2. Phase 0’s proposed mount-rule semantic change also cannot be proven by an untouched model.

### 9. Stable handle identity is an API break disguised as “strictly better”

**BLOCKER — Phase 1**

The current public contract says changed deps create a fresh node/handle ([README](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/README.md:137), [hook implementation](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/hooks.ts:236)).

Concrete break:

1. `useComputed(..., [idA])` returns `H`; `useEffect(() => registry.bind(H, idA), [H])` registers it.
2. Render changes to `idB`.
3. Phase 1 keeps `H` stable, so React does not clean up or rerun the effect. The registry still associates `H` with `idA` while reads now produce `idB`.
4. A `memo` child receiving only `H` may likewise legally skip the render because its prop is unchanged ([React `memo`](https://react.dev/reference/react/memo)). It then depends on the illegal mid-render delivery from finding 1.

This is not merely cache retention. React documents `useMemo` as an optimization whose cache may be discarded on initial suspension, file edits, and future conditions ([`useMemo` caveats](https://react.dev/reference/react/useMemo#caveats)). Guaranteeing surviving subscriptions/caches exceeds React, while removing the documented fresh-handle signal undershoots the existing cosignal contract. A same-deps hot edit is another concrete stale-function case: React may discard its memo cache, but the deps cutoff retains the old function.

### 10. Deleting the mount fast path changes pre-paint behavior

**BLOCKER — Phase 0**

Schedule:

1. Live transition `K` spans roots. Before mount pass `P`, it writes `a = 1`; `P` pins that receipt and a new watcher renders `1`.
2. After the pin, still-live `K` writes `a = 2`.
3. Root A commits `P` but `K` remains live because another root still spans it.
4. Mount fixup schedules a `mount-corrective` into `K`. Root A has also locked `K`, so its committed-now value is already `2`.
5. Current `clocksQuiet` is false; the ordinary `vFx` comparison emits an urgent pre-paint correction from `1` to `2` ([mount fixup](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:2836)).
6. The proposed always-covered comparison preserves `K`’s pre-pin `1` and excludes its corrected post-pin write, so it equals the rendered value and suppresses the urgent correction. The transition-lane corrective can commit later, allowing root A to paint `1` while its committed world is `2`.

Therefore the fast-path condition is semantic, not merely an optimization. “[Behavior must be observably identical](\/Users/jitl/src/alien-signals-opt/plans/2026-07-05-one-core-convergence.md:64)” is false.

### 11. Capsule deletion immediately breaks an existing `act()` retry contract

**MAJOR — Phase 2**

The binding battery already contains the requested counterexample:

1. Initial mount creates node `N1`, calls the lazy factory once, and suspends.
2. `act()` resolves `q1`.
3. React retries the initial mount from scratch, creating `N2`.
4. Without the cross-node capsule, `N2` calls the factory again. The existing test requires `fetches === 1`, including after that retry ([battery](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/tests/battery.spec.tsx:402)).

With the test’s shared gate promise this becomes two factory calls; with a genuinely uncached `fetch()` promise it can livelock.

**React parity:** deleting cross-node dedup is not itself a React undershoot. React documents that initial suspended mounts do not preserve state and tells applications/frameworks to cache promises externally ([React `use`](https://react.dev/reference/react/use#caching-promises-for-client-components)). The current capsule is gold-plating beyond that state guarantee. The attack is that Phase 2 knowingly changes a pinned cosignal contract while the plan still claims the existing full bindings battery as a phase gate.

### 12. A pull-based “consume gate” loses the first referee event

**MAJOR — Phase 0**

The lockstep adapter constructs the bridge, applies an operation, and only later calls `drainEvents()` ([adapter](/Users/jitl/src/alien-signals-opt/packages/cosignal/tests/oracle-adapter.ts:170)). If “consumed” becomes true on the first drain, every event from the first operation is already lost and lockstep diverges.

There is also no allocation win from putting a gate inside `log(e)`: callers construct `{type: ...}` before entering `log` ([current logger](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:936)). Avoiding that allocation requires checks at every event construction site or a lazy representation—hidden hot-path complexity.

Finally, direct callbacks do not preserve current timing. Today the shim records a cursor, lets the entire bridge operation finish, and translates afterward ([shim](/Users/jitl/src/alien-signals-opt/packages/cosignal-react/src/shim.ts:521)). A callback fired at the delivery log site runs while receipt propagation/effect flushing is still open, adding a new reentrancy and ordering contract.

### 13. The zero-cost checkpoint tests “no host,” not “React without transitions”

**MAJOR — Phase 0 / Phase 4**

The owner mandate is that an application which never uses transitions pays only predictable branches ([plan](/Users/jitl/src/alien-signals-opt/plans/2026-07-05-one-core-convergence.md:3)). A React application must attach the host, so the no-host probe tests a different population.

The current test proves only that internal counters stay zero with no bridge ([one-core test](/Users/jitl/src/alien-signals-opt/packages/cosignal/tests/one-core.spec.ts:49)). Once an atom is registered, even a plain synchronous write creates an ambient batch and receipts ([same test](/Users/jitl/src/alien-signals-opt/packages/cosignal/tests/one-core.spec.ts:156)). It therefore pays token lookup, tape append, marking, delivery, and event work despite never starting a transition.

This cannot be justified by checking whether a transition is currently present: the first write can itself notify a React consumer and create later scheduled work, so its attribution cannot be reconstructed retroactively. Deferring the only actual timing/allocation comparison until Phase 4, with “publish whatever the numbers are,” supplies no acceptance criterion for the Phase 0 promise.

### 14. “One entry” still leaves twins all the way down

**MAJOR — Phase 0 / Phase 3**

The current convergence implementation still explicitly maintains:

- K0 and K1 dependency graphs with union notification ([architecture comment](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:61));
- a kernel `Atom` plus an `AtomNode` wrapper and lookup map ([AtomNode](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:315));
- kernel computeds and separate overlay `ComputedNode`s;
- public write → host interceptor → overlay tape → public write re-entry, protected by `bridgeApplying`—the recursion guard Phase 0 claims to delete ([guard](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:640), [re-entry](/Users/jitl/src/alien-signals-opt/packages/cosignal/src/logged.ts:2075)).

The separate computed representation is not residue that can simply “migrate down or die”; it exists because using the kernel representation has already hung on stale cross-world links. Packaging both engines under one export removes an entrypoint and table swap, not the duplicated state, graphs, memo planes, or write interception that motivated the plan.

### Per-phase verdicts

- **Phase 0:** unsound.
- **Phase 1:** unsound.
- **Phase 2:** unsound.
- **Phase 3:** unsound.
- **Phase 4:** sound-with-amendments; its measurement/review activities are reasonable, but they occur too late and have no pass/fail threshold.

Overall, the plan conflates four lifetimes that React keeps distinct: pass frame versus active render call stack, batch lifetime versus one render attempt, hook/node identity versus resource-key identity, and committed component state versus speculative output. It then calls the resulting longer-lived state “strictly better,” even where React deliberately permits cache loss or clears aborted render updates. Conversely, it undershoots React where local render updates must retry coherently, owner identity matters, and promises are cached by input. The Phase 0 files changed during this review; citations above reflect the final dirty-working-tree snapshot I observed.

