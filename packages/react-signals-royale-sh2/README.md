# react-signals-royale-sh2

React bindings for `signals-royale-sh2`. The package uses a small React protocol that associates
signal drafts with transition lanes, tells the engine which draft set a render is consuming, and
reports commits. Signal reads therefore stay synchronous while concurrent renders see isolated
worlds and functional updates replay over newer urgent state.

Call `register()` once before rendering, or let the first hook register automatically. `useValue`
subscribes to an atom or computed value, `useComputed` owns a computed value for a component,
`useSignalEffect` observes committed state, and `useAtom` owns an atom until unmount.
`startTransitionWrite` runs signal writes and React updates in one transition batch.

`useIsPending` reports data hidden behind the current screen and `useCommitted` reads the canonical
screen value. Async computations accept a `use` callback for thenables, retain settled content
during urgent refetches, and suspend transition renders. `trace()` records bounded causal chains,
while `onDomMutation()` emits exact start and stop edges around React's host mutation phase.

For server rendering, assign stable `key` values to atoms, call `serializeAtomState` on the server,
then call `initializeAtomState` before the first client render. Installation replaces lazy state
without running its initializer or notifying subscribers.
