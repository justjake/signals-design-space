# react-signals-utils

Shared lifecycle bookkeeping for signal libraries hosted by the React fork in
this repository. React reports raw lanes, root renders, commits, and DOM
mutation windows through its private client internals. `ReactBatchRegistry`
turns those facts into stable batch identities.

A lane is scheduling state, not identity. React can reuse a lane after work
finishes, so the registry creates a new monotonically increasing token each
time a lane becomes live. Bit 0 records whether the batch is deferred; token
zero means no live batch. Root objects, rather than host containers, track
liveness so remounting into the same container cannot merge two roots.

```ts
import { ReactBatchRegistry } from 'react-signals-utils';

const registry = new ReactBatchRegistry(React);
const unsubscribe = registry.subscribe({
	onBatchOpened(token) {},
	onRenderPassStart(container, includedTokens) {},
	onRenderPassEnd(container, committed) {},
	onRootCommitted(container, committedTokens) {},
	onBatchRetired(token, committed) {},
});
```

`getCurrentWriteBatch()` returns the stable identity for a write issued now.
`getRenderContext()` identifies the currently executing render.
`runInBatch(token, fn)` schedules React updates in a live batch's lane; an
unknown or retired token executes `fn` at urgent priority. `liveTokens()` and
`isBatchLive()` expose liveness without duplicating registry state.

Only one registry can attach to a React runtime at a time. Listener errors are
recorded in `errors` and reported globally without escaping through React's
scheduler or commit. `dispose()` detaches the private consumer and releases all
state. `reset()` clears lifecycle state while preserving the attachment for
tests that reset an engine composition.
