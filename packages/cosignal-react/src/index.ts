/**
 * cosignal-react — public surface. The bindings couple `cosignal`'s
 * concurrent engine (dormant until registered; see the cosignal README's
 * "sync by default" posture) to the external-runtime protocol of a patched
 * React build; `registerCosignalReact()` activates both.
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
// actually consumes: the signal constructors the hooks accept (S-C: kernel
// `Computed` IS the supported derived type — `useComputed` returns one, and
// standalone instances world-route through the core's computed-read seam),
// the write/read utilities that are world-safe under React, and the types
// those signatures mention (`CosignalReactHandle.bridge` is a
// `CosignalEngine` — the module-level engine surface). Engine internals
// (`engine` the value, `attachDriver`, `Watcher`, `TraceEvent`, node/log
// entry types, …) stay available on the power-user path: import them from
// 'cosignal'.
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
} from 'cosignal';
