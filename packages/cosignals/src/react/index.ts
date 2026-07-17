/**
 * cosignals/react — React bindings for the engine, built on the
 * premise that React's own update queues are the source of truth for
 * which draft state a render pass may see (see host.ts).
 *
 * Runs on stock React: no patches, no build flags. Transitions, updater
 * rebase, and suspense behavior all go through public React semantics —
 * state updates, context, and effects.
 */
export { registerReactSignals, resetReactSignalsForTest, type ReactSignalsHandle } from './host.ts'
export { SignalsFrameworkProvider, wrapCreateRoot } from './SignalsFrameworkProvider.ts'
export {
	useValue,
	useComputed,
	useSignalEffect,
	useSignalLayoutEffect,
	useIsPending,
	useAtom,
	type SignalEffectSpec,
	type WatchSource,
	type WatchValue,
} from './hooks.ts'
export { startSignalTransition, useSignalTransition } from './transitions.ts'
