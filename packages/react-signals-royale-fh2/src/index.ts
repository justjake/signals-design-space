/**
 * react-signals-royale-fh2 — React bindings for the signals-royale-fh2
 * concurrent signal engine, built on the external-signals React seam.
 *
 * Registration fails loudly on a React build without the seam. Subscriptions
 * are fiber-granular: every subscribed component is its own engine
 * subscriber, scheduled precisely — canonical changes ride React's ambient
 * priority, draft changes ride the owning transition's lane.
 */
export {
	registerReactSignals,
	resetReactSignalsForTest,
	onDomMutation,
	getSeam,
	type ReactSignalsHandle,
	type MutationPhase,
} from './runtime';
export {
	useValue,
	useComputed,
	useSignalEffect,
	useIsPending,
	useCommitted,
	useAtom,
	startTransitionWrite,
} from './hooks';
export { traceView, type TraceView } from './trace';
