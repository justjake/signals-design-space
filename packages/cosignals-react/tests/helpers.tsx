/**
 * Shared harness: per-test ENGINE RESET + shim registration (`cosignals` has
 * default browser engine — `__TEST__resetEngine` is the fresh-engine
 * analog of the old per-test bridge construction), react-dom/client roots,
 * and act plumbing. The engine's event stream is its packed trace records —
 * the harness attaches the referee's lossless session tracer right after
 * the reset and exposes the decoded stream as `events` (the deleted object
 * log's shape).
 */
import type * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { __TEST__resetEngine, engine, type AtomInternals, type CosignalEngine, type WriteLogEntry } from 'cosignals';
import { attachRefereeStream, type RefereeStream } from '../../cosignals/tests/trace-events.js';
import { registerCosignalReact, type CosignalReactHandle } from '../src/index.js';

export type Harness = {
	handle: CosignalReactHandle;
	/** The default engine surface; the name is historical. */
	bridge: CosignalEngine;
	/** The decoded event stream (lossless session tracer attached at bridge
	 * birth; `events.eventsOfType(...)` replaces the old bridge log reads). */
	events: RefereeStream;
	/** Log entries as they dropped from the write logs — sealed-chunk folds
	 * and episode drops (op-replay-fidelity
	 * assertions; fed by the engine's onLogEntryDrop referee seam). */
	compacted: Array<{ atom: AtomInternals; entry: WriteLogEntry }>;
	roots: Root[];
	containers: HTMLElement[];
	/** createRoot over a fresh container div. */
	mount(node: React.ReactNode): Promise<{ root: Root; container: HTMLElement }>;
	newRoot(): { root: Root; container: HTMLElement };
	cleanup(): Promise<void>;
};

export function makeHarness(opts?: { devChecks?: boolean }): Harness {
	// Close out whatever episode the previous test left open (a test may
	// legitimately end mid-render or with an unsettled parked action; the old
	// per-test bridges were simply abandoned — the ONE engine closes the
	// episode out instead, so the reset's idle preconditions hold).
	engine.discardAllWip();
	for (const t of engine.liveBatches()) {
		if (t.parked) engine.settleAction(t.id);
		else engine.retire(t.id);
	}
	// devChecks arms by default so the suite exercises the protocol-edge
	// throws and the dev warnings; pass { devChecks: false } to pin the
	// production posture (defined fall-throughs, no warning allocation).
	__TEST__resetEngine({ devChecks: opts?.devChecks ?? true });
	// The referee stream attaches AFTER the reset (the fresh composition's
	// trace slot starts empty) and before the first engine operation, so the
	// session is complete from event 0.
	const events = attachRefereeStream(engine);
	const compacted: Array<{ atom: AtomInternals; entry: WriteLogEntry }> = [];
	engine.onLogEntryDrop = (atom, entry) => compacted.push({ atom, entry });
	const handle = registerCosignalReact();
	const roots: Root[] = [];
	const containers: HTMLElement[] = [];
	const h: Harness = {
		handle,
		bridge: engine,
		events,
		compacted,
		roots,
		containers,
		newRoot() {
			const container = document.createElement('div');
			document.body.appendChild(container);
			const root = createRoot(container);
			roots.push(root);
			containers.push(container);
			return { root, container };
		},
		async mount(node) {
			const made = h.newRoot();
			await act(async () => {
				made.root.render(node);
			});
			return made;
		},
		async cleanup() {
			// Assert the shim never swallowed a listener error mid-test.
			const errors = handle.shim.takeErrors();
			await act(async () => {
				for (const root of roots) root.unmount();
			});
			await act(async () => {}); // drain debounced unsubscribes
			for (const c of containers) c.remove();
			handle.dispose();
			if (errors.length > 0) {
				throw new Error(`shim recorded errors: ${errors.map((e) => String(e)).join(' | ')}`);
			}
		},
	};
	return h;
}

export { act };

/** Text content of a container, whitespace-collapsed. */
export function text(container: HTMLElement): string {
	return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** A deferred promise with exposed resolve/reject and a caller-managed flag. */
export function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
	settled: boolean;
} {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject, settled: false };
}

/** Wait for real timers/microtasks outside act (transition scheduling). */
export function tick(ms = 0): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}
