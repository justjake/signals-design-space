/**
 * cosignal-react — public surface (spec §3.2). The bindings ride the LOGGED
 * engine (`cosignal/logged`) and the linked React fork's external-runtime
 * protocol; `registerCosignalReact()` activates both. The DIRECT entry
 * (`cosignal`) is never imported here — the twin-build promise (§7) holds:
 * apps that skip this package carry zero concurrency instructions.
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
