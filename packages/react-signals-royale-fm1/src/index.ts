/**
 * react-signals-royale-fm1 — React bindings for the signals-royale-fm1
 * engine over the signal-seam React fork.
 *
 * Register once at startup (fails loudly on stock React), then use atoms and
 * computeds through the hooks. Transition writes stay invisible to the
 * committed DOM until React commits the transition; urgent writes commit
 * alone, immediately; a transition retiring later replays its write intents
 * on top of whatever committed meanwhile.
 */
export {
	register,
	resetForTest,
	set,
	update,
	startTransitionWrite,
	onDomMutation,
	currentWriteBatch,
	readInRenderWorld,
} from './runtime.ts';

export {
	useValue,
	useComputed,
	useSignalEffect,
	useIsPending,
	useCommitted,
	useAtom,
	useTransitionWrite,
} from './hooks.ts';

export { trace, type RoyaleTraceView } from './trace.ts';

export {
	atom,
	computed,
	effect,
	effectScope,
	batch,
	untracked,
	latest,
	committed,
	isPending,
	refresh,
	serializeAtomState,
	initializeAtomState,
	installState,
	Atom,
	Computed,
	Tracer,
	type AtomOptions,
	type Readable,
} from 'signals-royale-fm1';
