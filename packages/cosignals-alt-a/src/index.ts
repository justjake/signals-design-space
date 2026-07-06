/**
 * cosignals-alt-a — variant A (monotonic write-gate activation) of the
 * react-concurrent-signals-arena-alt-a spec, milestones M0–M3.
 */
export {
	createCosignalEngine,
	type CosignalEngine,
	type AtomHandle,
	type ReducerAtomHandle,
	type ComputedHandle,
	type SignalHandle,
	type WatcherHandle,
	type BroadcastEvent,
	type WorldSelector,
	type EngineOptions,
	type Equality,
} from './engine';
export {
	createForkDouble,
	type ForkDouble,
	type ForkAdapter,
	type BatchScript,
	type PassScript,
	type Container,
	type ExternalRuntimeListener,
} from './fork-double';
