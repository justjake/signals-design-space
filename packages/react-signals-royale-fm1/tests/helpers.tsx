// @vitest-environment jsdom
/**
 * Shared harness: register the runtime against the forked build, raw
 * createRoot + act from 'react' (no RTL), per-test reset.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { register, resetForTest } from '../src/index.ts';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

export interface Harness {
	roots: Root[];
	containers: HTMLElement[];
	mount(node: React.ReactNode): Promise<{ root: Root; container: HTMLElement }>;
	newRoot(): { root: Root; container: HTMLElement };
	cleanup(): Promise<void>;
}

export function makeHarness(): Harness {
	register();
	resetForTest();
	const roots: Root[] = [];
	const containers: HTMLElement[] = [];
	const harness: Harness = {
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
			const { root, container } = harness.newRoot();
			await act(async () => {
				root.render(node);
			});
			return { root, container };
		},
		async cleanup() {
			for (const root of roots) {
				await act(async () => {
					root.unmount();
				});
			}
			for (const container of containers) container.remove();
		},
	};
	return harness;
}

export { React, act };
export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
