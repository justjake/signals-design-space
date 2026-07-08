/**
 * The host runtime: glue between the engine and the external-signals seam
 * of the patched React build.
 *
 * The model is fiber-granular. React tells this runtime who is rendering
 * (render passes with their root and lanes) and when each root's work
 * reaches the screen (commit phases, bracketing the DOM mutation window).
 * The runtime tells the engine how to classify writes: a write inside a
 * React transition scope belongs to the draft batch keyed by that
 * transition's lane, so the batch's lifetime IS the lane's lifetime — the
 * batch retires exactly when a commit carries its lane, and every batch
 * gets a guaranteed close edge by scheduling its lane on a live root.
 */
import {
	unstable_externalSignals,
	type ExternalSignalsSeam,
	type ExternalSignalsRuntime,
	type SignalsFiberRoot,
} from 'react-dom/client';
import {
	type Batch,
	batchForKey,
	openBatchForKey,
	openBatches,
	retireBatch,
	host,
	subscriberErrors,
	emit,
	tracing,
	__resetEngine,
} from 'signals-royale-fh2';

export type MutationPhase = 'start' | 'stop';

export function getSeam(): ExternalSignalsSeam {
	const seam = unstable_externalSignals;
	if (seam === undefined || typeof seam.inject !== 'function') {
		throw new Error(
			'react-signals-royale-fh2 requires a React build with the external-signals seam ' +
				"(react-dom/client must export 'unstable_externalSignals'); this React build does not have it.",
		);
	}
	return seam;
}

interface PassRec {
	root: SignalsFiberRoot;
	lanes: number;
	batches: Batch[];
}

const passByRoot = new Map<SignalsFiberRoot, PassRec>();
let currentPass: PassRec | null = null;
let kickRoot: WeakRef<SignalsFiberRoot> | null = null;
const pendingKicks = new Set<number>();
const mutationListeners = new Set<(phase: MutationPhase, container: Element) => void>();
const commitListeners = new Set<() => void>();

/** The pass whose render is executing right now, if any: hooks resolve
 * their world (and `read()` resolves ambient renders) against it. */
export function renderingPass(): PassRec | null {
	return getSeam().isRenderPhase() ? currentPass : null;
}

/** The world a snapshot probe for `root` should resolve: the root's open
 * (rendered-but-uncommitted) pass, else canonical. */
export function snapshotPass(root: SignalsFiberRoot | null): PassRec | null {
	if (root === null) {
		return null;
	}
	return passByRoot.get(root) ?? null;
}

function laneBatches(lanes: number): Batch[] {
	const out: Batch[] = [];
	for (const b of openBatches()) {
		if (((b.key as number) & lanes) !== 0) {
			out.push(b);
		}
	}
	return out;
}

/** Classifies a write: inside a React transition scope, the draft batch
 * keyed by the transition's lane; otherwise canonical (urgent). */
function classifyWrite(): Batch | null {
	const seam = getSeam();
	const lane = seam.currentTransitionLane();
	if (lane === 0) {
		return null;
	}
	let b = openBatchForKey(lane);
	if (b === undefined) {
		b = batchForKey(lane);
		// The close edge: mark the lane pending on a live root so it renders
		// and commits (retiring the batch) even with zero subscribers.
		const root = kickRoot?.deref();
		if (root !== undefined) {
			seam.scheduleRootLane(root, lane);
		} else {
			pendingKicks.add(lane);
		}
	}
	return b;
}

function assertWriteAllowed(): void {
	if (getSeam().isRenderPhase()) {
		throw new Error(
			'signals-royale-fh2: writing a signal during render is not allowed. ' +
				'Move the write to an event handler, an effect, or a transition scope.',
		);
	}
}

const runtime: ExternalSignalsRuntime = {
	onPassStarted(root, lanes) {
		kickRoot = new WeakRef(root);
		if (pendingKicks.size > 0) {
			const seam = getSeam();
			for (const lane of pendingKicks) {
				if (openBatchForKey(lane) !== undefined) {
					seam.scheduleRootLane(root, lane);
				}
			}
			pendingKicks.clear();
		}
		const rec: PassRec = { root, lanes, batches: laneBatches(lanes) };
		passByRoot.set(root, rec);
		currentPass = rec;
		if (tracing()) {
			emit('pass-start', { lanes });
		}
	},
	onPassDiscarded(root, lanes) {
		passByRoot.delete(root);
		if (currentPass !== null && currentPass.root === root) {
			currentPass = null;
		}
		if (tracing()) {
			emit('pass-end', { lanes, disposition: 'discard' });
		}
	},
	onCommitPhase(root, phase, lanes) {
		if (phase !== 'committed') {
			if (tracing()) {
				emit('mutation-window', { phase: phase === 'mutation-start' ? 'start' : 'stop' });
			}
			const p: MutationPhase = phase === 'mutation-start' ? 'start' : 'stop';
			for (const cb of mutationListeners) {
				try {
					cb(p, root.containerInfo);
				} catch (e) {
					subscriberErrors.push(e);
				}
			}
			return;
		}
		const commitEvent = tracing() ? emit('root-commit', { lanes }) : 0;
		if (tracing()) {
			emit('pass-end', { lanes, disposition: 'commit' }, commitEvent);
		}
		// Retire every batch whose lane this commit carried: the drafts fold
		// canonically inside the commit, before layout and passive effects.
		for (const b of laneBatches(lanes)) {
			retireBatch(b);
		}
		passByRoot.delete(root);
		if (currentPass !== null && currentPass.root === root) {
			currentPass = null;
		}
		for (const cb of commitListeners) {
			try {
				cb();
			} catch (e) {
				subscriberErrors.push(e);
			}
		}
	},
};

export interface ReactSignalsHandle {
	/** Listener exceptions the runtime swallowed to protect propagation. */
	errors: unknown[];
	dispose(): void;
}

let installed: (() => void) | null = null;

/**
 * Registers the runtime with the React build (idempotent per process) and
 * installs the engine's host seams. Throws on a React build without the
 * external-signals seam.
 */
export function registerReactSignals(): ReactSignalsHandle {
	const seam = getSeam();
	host.classify = classifyWrite;
	host.assertCanWrite = assertWriteAllowed;
	host.renderWorld = () => {
		const p = renderingPass();
		return p === null ? null : p.batches;
	};
	if (installed === null) {
		installed = seam.inject(runtime);
	}
	return {
		errors: subscriberErrors,
		dispose() {
			host.classify = null;
			host.assertCanWrite = null;
			host.renderWorld = null;
		},
	};
}

/** Subscribes to the DOM mutation window: `start` fires immediately before
 * React mutates a root's DOM, `stop` immediately after, per commit. */
export function onDomMutation(cb: (phase: MutationPhase, container: Element) => void): () => void {
	mutationListeners.add(cb);
	return () => {
		mutationListeners.delete(cb);
	};
}

/** Runs `cb` after every root commit (committed views may have advanced). */
export function onRootCommit(cb: () => void): () => void {
	commitListeners.add(cb);
	return () => {
		commitListeners.delete(cb);
	};
}

/** Test seam: full engine + runtime reset. */
export function resetReactSignalsForTest(): void {
	passByRoot.clear();
	currentPass = null;
	kickRoot = null;
	pendingKicks.clear();
	mutationListeners.clear();
	commitListeners.clear();
	__resetEngine();
}
