/** cosignals-alt-a/react — real-React bindings (§4.5/§13 over the §6 bridge). */
export { attachReactBridge, assertForkPresent, type ReactBridgeHandle } from './bridge';
export {
	registerAltAReact,
	useSignal,
	useIsPending,
	useAtom,
	useReducerAtom,
	useComputed,
	useSignalEffect,
	startSignalTransition,
	useSignalTransition,
	type AltAReactHandle,
	type SignalSource,
} from './hooks';
