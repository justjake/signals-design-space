// Shared helpers for the real-React gate: raw createRoot + act from the fork
// build, no testing-library (repo convention).
import * as React from 'react';
import { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { __resetEngine } from 'signals-royale-fh1';
import { register, resetHostForTest } from '../src/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export { React, act };

const roots: Array<{ unmount(): void }> = [];
const containers: HTMLElement[] = [];

export function setup(): void {
	register();
}

export async function teardown(): Promise<void> {
	await act(async () => {
		for (const r of roots) r.unmount();
	});
	for (const c of containers) c.remove();
	roots.length = 0;
	containers.length = 0;
	__resetEngine();
	resetHostForTest();
	register();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

export function newRoot(): {
	root: { render(node: React.ReactNode): void; unmount(): void };
	container: HTMLElement;
} {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = ReactDOMClient.createRoot(container);
	roots.push(root);
	containers.push(container);
	return { root, container };
}

export async function mount(node: React.ReactNode): Promise<{
	root: { render(n: React.ReactNode): void; unmount(): void };
	container: HTMLElement;
}> {
	const made = newRoot();
	await act(() => {
		made.root.render(node);
	});
	return made;
}

export function text(container: HTMLElement): string {
	return (container.textContent ?? '').replace(/\s+/g, '');
}

export function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	settled: boolean;
} {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	const d = {
		promise,
		resolve: (v: T) => {
			d.settled = true;
			resolve(v);
		},
		settled: false,
	};
	return d;
}

export function tick(ms = 0): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}
