/**
 * signals-royale-fh1 — a concurrent signal engine where every write is a
 * version-stamped record and every reader is a visibility predicate evaluated
 * over small per-signal write histories.
 */
export {
	Atom,
	Computed,
	Effect,
	EffectScope,
	Batch,
	World,
	PendingValue,
	URGENT,
	effect,
	effectScope,
	batch,
	startBatch,
	endBatch,
	untracked,
	createBatch,
	liveBatches,
	makeWorld,
	inWorld,
	readInWorld,
	read,
	latest,
	committed,
	isPending,
	refresh,
	currentSeq,
	subscribeHook,
	settleObservationsNow,
	installValue,
	serializeAtomState,
	initializeAtomState,
	installState,
	setStampProvider,
	setWriteGuard,
	setCommittedCutoffProvider,
	hasSettled,
	lastSettled,
	lastDeliveryEvent,
	__resetEngine,
} from './engine';
export type {
	AtomOptions,
	ComputedOptions,
	Use,
	HookPoke,
	WriteSeq,
	BatchId,
	AnyAtom,
	AnyComputed,
	Node,
} from './engine';
export {
	startTrace,
	tracing,
	emit,
	setCause,
	getCause,
	withCause,
	formatEvent,
} from './tracer';
export type { TraceEvent, TraceHandle, EventId } from './tracer';
import { Atom, Computed, effect as effectFn, type AtomOptions, type ComputedOptions, type Use } from './engine';

/** Create a writable signal. A function-valued initial state is a lazy
 * initializer: it runs once, untracked, at first read, write, or subscription. */
export function atom<T>(initial: T | (() => T), opts?: AtomOptions<T>): Atom<T> {
	return new Atom(initial, opts);
}

/** Create a lazy, cached, equality-cutoff derived value. The `use` argument
 * unwraps thenables: settled work resolves synchronously, pending work parks
 * the evaluation as graph state. */
export function computed<T>(fn: (use: Use) => T, opts?: ComputedOptions<T>): Computed<T> {
	return new Computed(fn, opts);
}

export const signal = atom;
export const createEffect = effectFn;
