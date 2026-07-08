# reack-strata

`reack-strata` binds Strata signals directly to concurrent React. It requires the
included React 19.2.7 patch; importing it against stock React fails immediately.

```sh
./build.sh
```

The patch adds one unstable bridge. React reports render start, interruption,
completion, commit, and its exact DOM mutation window; it also lets a signal
notification reuse the lane that caused it. All graph policy, branch journals,
per-root screen state, subscription ownership, and effect semantics remain in this
package rather than in React.

```tsx
import { Atom } from 'strata-signals';
import {
	startSignalTransition,
	useIsPending,
	useSignal,
	useSignalEffect,
} from 'reack-strata';

const count = new Atom(0);

function Counter() {
	const value = useSignal(count);
	const pending = useIsPending(count);
	useSignalEffect(() => console.log('committed', count.state), [value]);
	return <button onClick={() => startSignalTransition(() => count.update((n) => n + 1))}>
		{value} {pending && '…'}
	</button>;
}
```

`useSignalEffect` is a committed-world terminal. A signal-only notification runs
it without forcing the component to render; when React props and the signal both
carry the same change, the committed root cutoff coalesces them into one run.

Other exports include `useLatest`, `useCommitted`, `useComputed`, `useAtom`,
`useReducerAtom`, `useSignalTransition`, `committed(source, container)`, and
`onDomMutation`. The mutation callback receives `start` immediately before React's
mutation phase and `stop` immediately after it, outside layout and passive effects.
