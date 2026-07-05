/**
 * cosignal-react — public surface. The bindings ride the logged build's
 * concurrent engine (`cosignal/logged`) and the external-runtime protocol,
 * version 1, of a patched React build; `registerCosignalReact()` activates
 * both. The plain `cosignal` entry is never imported here, preserving the
 * base library's isolation promise: apps that skip this package carry zero
 * concurrency code.
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
export { Shim, assertForkProtocol, REQUIRED_CAPABILITIES, REQUIRED_PROTOCOL_VERSION, type BoundCtx, type WatcherTarget } from './shim.js';

// Curated re-export of the engine surface an app using these bindings
// actually consumes: the signal constructors the hooks accept (`useSignal`
// rejects kernel `Computed` — component-scoped derivations come from
// `useComputed`), the write/read utilities that are world-safe under React,
// and the types those signatures mention (`CosignalReactHandle.bridge` is a
// `CosignalBridge`). Bridge internals (`CosignalBridge` the value, `Tape`,
// `Watcher`, `BridgeEvent`, node/receipt types, …) stay available on the
// power-user path: import them from 'cosignal/logged'.
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
} from 'cosignal/logged';
