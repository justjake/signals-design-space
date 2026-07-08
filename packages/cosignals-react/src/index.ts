/**
 * cosignals-react — public surface. The bindings couple `cosignals`'s
 * default concurrent engine to the external-runtime protocol of a patched
 * React build: `registerCosignalReact()` attaches the engine's driver and
 * subscribes to the protocol's events, and the hooks below are the
 * component-side surface.
 */

export {
	registerCosignalReact,
	requireShim,
	useSignal,
	useComputed,
	useReducerAtom,
	useSignalEffect,
	startSignalTransition,
	type CosignalReactHandle,
	type SignalSource,
} from './hooks.js';
export { Shim, assertForkPresent, type BoundCtx, type WatcherTarget } from './shim.js';

// Curated re-export of the engine surface an app using these bindings
// actually consumes: the signal constructors the hooks accept (kernel
// `Computed` is the supported derived type — `useComputed` returns one, and
// standalone instances world-route through the core's computed-read seam),
// the write/read utilities that are world-safe under React, and the types
// those signatures mention (`CosignalReactHandle.bridge` is the default
// instance's `CosignalEngine`). Engine internals
// (`engine` the value, `attachDriver`, `Watcher`, `TraceEvent`, node/log
// entry types, …) stay available on the power-user path: import them from
// 'cosignals'.
export {
	Atom,
	Computed,
	ReducerAtom,
	batch,
	untracked,
	effect,
	effectScope,
	SuspendedRead,
	type AtomOptions,
	type AtomCtx,
	type ComputedOptions,
	type ReducerAtomOptions,
	type CosignalEngine,
} from 'cosignals';
