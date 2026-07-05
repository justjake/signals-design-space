/**
 * Shared harness: per-test bridge + shim registration (fresh
 * `__newBridgeForTest()` instances so cosignal's public once-rule stays
 * intact for real apps), react-dom/client roots, and act plumbing.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { __newBridgeForTest, type CosignalBridge } from 'cosignal';
import { registerCosignalReact, type CosignalReactHandle } from '../src/index.js';

export type Harness = {
	handle: CosignalReactHandle;
	bridge: CosignalBridge;
	roots: Root[];
	containers: HTMLElement[];
	/** createRoot over a fresh container div. */
	mount(node: React.ReactNode): Promise<{ root: Root; container: HTMLElement }>;
	newRoot(): { root: Root; container: HTMLElement };
	cleanup(): Promise<void>;
};

export function makeHarness(): Harness {
	const bridge = __newBridgeForTest();
	// The engine moves compacted receipts to its archive only on request —
	// these tests inspect full receipt history (tape + archive).
	bridge.retainArchive = true;
	const handle = registerCosignalReact({ bridge });
	const roots: Root[] = [];
	const containers: HTMLElement[] = [];
	const h: Harness = {
		handle,
		bridge,
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
