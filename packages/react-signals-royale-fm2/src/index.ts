/**
 * react-signals-royale-fm2 — React bindings for the signals-royale-fm2
 * concurrent signal engine, targeting the patched React build in this
 * package (see patches/ and build.sh).
 */
export {
	register,
	startTransitionWrite,
	onDomMutation,
	runWithLane,
	resetForTest,
	getView,
	getCurrentRenderContainer,
	type HostHandle,
	type LaneBatch,
	type Lanes,
} from './host.ts';

export {
	useValue,
	useComputed,
	useSignalEffect,
	useIsPending,
	useCommitted,
	useAtom,
} from './hooks.ts';

export { whyLastDelivery, traceView, type TraceView } from './trace.ts';
