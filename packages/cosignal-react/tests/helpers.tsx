/**
 * Shared harness: per-test bridge + shim registration (fresh
 * `__newBridgeForTest()` instances so cosignal's public once-rule stays
 * intact for real apps), react-dom/client roots, and act plumbing. The
 * engine's event stream is its packed trace records — the harness attaches
 * the referee's lossless session tracer at bridge birth and exposes the
 * decoded stream as `events` (the deleted object log's shape).
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { __newBridgeForTest, type AtomNode, type CosignalBridge, type WriteLogEntry } from 'cosignal';
import { attachRefereeStream, type RefereeStream } from '../../cosignal/tests/trace-events.js';
import { registerCosignalReact, type CosignalReactHandle } from '../src/index.js';

export type Harness = {
	handle: CosignalReactHandle;
	bridge: CosignalBridge;
	/** The decoded event stream (lossless session tracer attached at bridge
	 * birth; `events.eventsOfType(...)` replaces the old bridge log reads). */
	events: RefereeStream;
	/** Log entries as compaction folded them out of the write logs (op-replay-fidelity
	 * assertions; fed by the engine's onCompact referee seam). */
	compacted: Array<{ atom: AtomNode; entry: WriteLogEntry }>;
	roots: Root[];
	containers: HTMLElement[];
	/** createRoot over a fresh container div. */
	mount(node: React.ReactNode): Promise<{ root: Root; container: HTMLElement }>;
	newRoot(): { root: Root; container: HTMLElement };
	cleanup(): Promise<void>;
};

export function makeHarness(opts?: { devChecks?: boolean }): Harness {
	// devChecks arms by default so the suite exercises the protocol-edge
	// throws and the dev warnings; pass { devChecks: false } to pin the
	// production posture (defined fall-throughs, no warning allocation).
	const bridge = __newBridgeForTest({ devChecks: opts?.devChecks ?? true });
	const events = attachRefereeStream(bridge);
	const compacted: Array<{ atom: AtomNode; entry: WriteLogEntry }> = [];
	bridge.onCompact = (atom, entry) => compacted.push({ atom, entry });
	const handle = registerCosignalReact({ bridge });
	const roots: Root[] = [];
	const containers: HTMLElement[] = [];
	const h: Harness = {
		handle,
		bridge,
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
