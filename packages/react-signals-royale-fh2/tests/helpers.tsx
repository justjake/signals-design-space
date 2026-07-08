/**
 * Shared harness: per-test registration + engine reset, raw
 * react-dom/client roots, act plumbing (no RTL — repo convention).
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { registerReactSignals, resetReactSignalsForTest, type ReactSignalsHandle } from '../src/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Harness {
	handle: ReactSignalsHandle;
	roots: Root[];
	containers: HTMLElement[];
	newRoot(): { root: Root; container: HTMLElement };
	mount(node: React.ReactNode): Promise<{ root: Root; container: HTMLElement }>;
	cleanup(): Promise<void>;
}

export function makeHarness(): Harness {
	resetReactSignalsForTest();
	const handle = registerReactSignals();
	const roots: Root[] = [];
	const containers: HTMLElement[] = [];
	const h: Harness = {
		handle,
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
			const errors = [...handle.errors];
			await act(async () => {
				for (const root of roots) {
					root.unmount();
				}
			});
			await act(async () => {}); // drain debounced observation settles
			for (const c of containers) {
				c.remove();
			}
			handle.dispose();
			if (errors.length > 0) {
				throw new Error(`runtime swallowed errors: ${errors.map(String).join(' | ')}`);
			}
		},
	};
	return h;
}

export { act };

/** Text content of a container, whitespace-collapsed. */
export function text(container: HTMLElement): string {
	return (container.textContent ?? '').replace(/\s+/g, '');
}

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
	const d = {
		promise,
		resolve: (v: T) => {
			d.settled = true;
			resolve(v);
		},
		reject,
		settled: false,
	};
	return d;
}

/** Real timers outside act (transition scheduling). */
export function tick(ms = 0): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}
