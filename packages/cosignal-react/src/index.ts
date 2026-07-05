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

// Re-export the engine's public surface so applications can import one path.
export * from 'cosignal/logged';
