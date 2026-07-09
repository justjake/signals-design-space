# react-signals-royale-fx1

React bindings for `signals-royale-fx1`, plus the 80-line React patch series
that makes truly concurrent external state possible.

## The idea: the store schedules, React renders

Every other way of connecting an external store to React has the store
*reacting* to React: subscribe, get notified, force a synchronous re-render
(`useSyncExternalStore` — which documents that its stores cannot take part
in non-blocking transitions). This package inverts the relationship. The
store owns update scheduling:

1. A write inside a transition scope opens an engine **episode**. The
   runtime claims a React **lane** for it — once — and pins that lane on the
   transition object it dispatches under.
2. Every re-render request for that episode goes out under the same pinned
   lane: the original deliveries, the corrective join for a component that
   mounts mid-transition, and the settlement of async data the episode owns.
   React therefore commits all of it as one batch — corrective renders land
   *inside* the owning commit, never beside it.
3. React reports back three facts through a bridge the patch series adds:
   a render pass started (root + lanes), a root committed (root + lanes),
   and the exact DOM mutation window. The engine maps lanes to episodes,
   pins a read frame per pass (so time-sliced renders never tear), snapshots
   per-root committed views at commits, and retires episodes that have
   committed everywhere.

The React changes are three call sites and one bridge module — measured with
`git diff --numstat` against the pinned upstream base, 80 lines total. Run
`./build.sh` to apply `patches/` to a pristine checkout at
`e71a6393e66b0d2add46ba2b2c5db563a0563828` and build; the packages here link
against the build artifacts.

## Usage

```tsx
import { atom } from 'signals-royale-fx1';
import { register, useValue, startTransitionWrite } from 'react-signals-royale-fx1';

register(); // once, after react-dom loads; throws on a build without the bridge

const query = atom('');
function Results() {
  const q = useValue(query); // resolves this render pass's world
  return <ul>{search(q)}</ul>;
}
function Input() {
  return (
    <input
      onChange={(e) => {
        startTransitionWrite(() => query.set(e.target.value));
      }}
    />
  );
}
```

Urgent writes (outside any transition) commit immediately. Transition writes
stay invisible to the committed DOM and to canonical readers until React
commits that batch; urgent writes that land meanwhile commit alone, and the
pending batch replays on top in scheduling order.

## Hooks

- `useValue(x)` — subscribing read. Renders the pass's own world; claims its
  engine subscription in a commit effect with post-subscribe fixup. Pending
  async values follow the two-level rule: transition renders hand React the
  (stable) thenable and hold; urgent renders with settled history serve the
  stale value; never-settled suspends.
- `useComputed(fn, deps)` — component-local computed, memoized on `deps`.
- `useAtom(initial, opts?)` — component-owned atom, reclaimed after unmount.
- `useSignalEffect(fn)` — engine effect for the component's lifetime.
- `useIsPending(x)` — subscribes to the pending flip.
- `useCommitted(x)` — subscribes to the on-screen value.
- `useTransitionWrite()` — `[isPending, start]`, marrying React
  `useTransition` with an engine batch.
- `startTransitionWrite(scope)` — the imperative transition helper. Nested
  inside an existing transition it joins that batch.
- `onDomMutation(cb)` — subscribe to the exact DOM mutation window per root
  commit (`start` right before React mutates, `stop` right after; layout and
  passive effects are outside the window).

Write-during-render fails loudly. Multiple roots are supported; one
transition spanning several roots stays consistent per root, and
`committed(x, container)` answers per root.

## Verification

`tests/` carries the real-React gate (the 18 required scenarios driven
through raw `createRoot` + `act` against the fork build), plus GC leak
audits. The fork's own invariants live in the React checkout as jest suites
(`yarn test --no-watchman ReactDOMSignalScheduler`). See `REPORT.md` for the
full gate table.
