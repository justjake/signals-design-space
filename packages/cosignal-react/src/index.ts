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
	BoundComputed,
	type ActionScope,
	type CosignalReactHandle,
	type SignalSource,
} from './hooks.js';
export { Shim, assertForkPresent, type BoundCtx, type WatcherTarget } from './shim.js';

// Curated re-export of the engine surface an app using these bindings
// actually consumes: the signal constructors the hooks accept (`useSignal`
// rejects kernel `Computed` — component-scoped derivations come from
// `useComputed`), the write/read utilities that are world-safe under React,
// and the types those signatures mention (`CosignalReactHandle.bridge` is a
// `CosignalBridge`). Bridge internals (`CosignalBridge` the value, `Tape`,
// `Watcher`, `BridgeEvent`, node/receipt types, …) stay available on the
// power-user path: import them from 'cosignal'.
export {
	Atom,
	ReducerAtom,
	batch,
	untracked,
	effect,
	effectScope,
	SuspendedRead,
	type AtomOptions,
	type AtomCtx,
	type ReducerAtomOptions,
	type CosignalBridge,
} from 'cosignal';
