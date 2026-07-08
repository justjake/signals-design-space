/**
 * signals-royale-fh2 — a concurrent signal engine for React.
 *
 * Canonical state lives in a push-pull reactive graph (atoms, lazy cached
 * computeds, effects). Pending React transitions are draft batches: ordered
 * operation logs folded over the canonical base on demand, so a render pass
 * can read a self-consistent speculative world while committed readers and
 * effects keep seeing exactly the committed-plus-urgent timeline. Batch
 * retirement replays the operations as ordinary writes — functional updates
 * re-execute against the value at retirement, which is how an urgent write
 * that lands mid-transition is rebased under the transition's updates.
 */
export {
	atom,
	computed,
	set,
	update,
	setInBatch,
	updateInBatch,
	read,
	latest,
	committed,
	isPending,
	refresh,
	readInWorld,
	retryThenable,
	settledHistory,
	worldStamp,
	pendingBatchesFor,
	debugId,
	effect,
	effectScope,
	subscribe,
	onPendingFlip,
	openBatch,
	batchForKey,
	openBatchForKey,
	openBatches,
	retireBatch,
	discardBatch,
	reportCommittedValue,
	serializeAtomState,
	initializeAtomState,
	installState,
	isPendingValue,
	AsyncError,
	host,
	subscriberErrors,
	currentPendingEpoch,
	currentGraphEpoch,
	quiescent,
	__internals,
	__resetEngine,
	type Atom,
	type Computed,
	type Readable,
	type Use,
	type AtomOptions,
	type ComputedOptions,
	type Batch,
	type Delivery,
	type SubscriptionHandle,
	type PendingBox,
	type HostSeams,
} from './engine';
export { batch, startBatch, endBatch, untracked } from './graph';
export { attachTracer, emit, withCause, tracing, type Tracer, type TraceEvent, type TraceEventKind } from './tracer';
