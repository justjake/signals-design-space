/**
 * signals-royale-fx2-dalien/react — React bindings for the signals-royale-fx2-dalien
 * engine, built on the premise that React's own update queues are the
 * source of truth for which draft state a render pass may see.
 *
 * Runs on stock React — no patches, no build flags. Transition worlds,
 * rebase, per-root committed views, and suspense behavior all ride public
 * React semantics (state updates, context, effects).
 */
export { registerReactSignals, resetReactSignalsForTest, type ReactSignalsHandle } from './host.ts'
export { SignalScopeProvider, wrapCreateRoot, ScopeContext } from './SignalScopeProvider.ts'
export {
	useValue,
	useComputed,
	useSignalEffect,
	useSignalLayoutEffect,
	useIsPending,
	useCommitted,
	useAtom,
} from './hooks.ts'
export { startSignalTransition, useSignalTransition } from './transitions.ts'
