// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Atom, Computed } from 'strata-signals';
import {
	resetForTest,
	useCommitted,
	useLatest,
	useReducerAtom,
} from '../src/index.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
	true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	resetForTest();
});

test('useReducerAtom has useReducer shape with replayable actions', async () => {
	let dispatch!: (amount: number) => void;
	function App() {
		const [value, send] = useReducerAtom((state: number, amount: number) => state + amount, 1);
		dispatch = send;
		return <span>{value}</span>;
	}

	await act(() => root.render(<App />));
	await act(() => React.startTransition(() => dispatch(2)));
	expect(container.textContent).toBe('3');
});

test('useCommitted follows the value each root has actually committed', async () => {
	const value = new Atom(0);
	function App() {
		return <span>{useCommitted(value)}</span>;
	}

	await act(() => root.render(<App />));
	await act(async () => {
		value.set(1);
		await Promise.resolve();
	});
	expect(container.textContent).toBe('1');
});

test('useLatest serves settled data instead of suspending on refresh', async () => {
	let resolve!: (value: number) => void;
	let promise = Promise.resolve(1);
	const value = new Computed<number>(({ use }) => use(promise));
	function App() {
		return <span>{useLatest(value) ?? 'none'}</span>;
	}

	await act(async () => {
		root.render(<App />);
		await promise;
	});
	expect(container.textContent).toBe('1');

	promise = new Promise<number>((done) => {
		resolve = done;
	});
	await act(() => value.runtime.refresh(value));
	expect(container.textContent).toBe('1');
	await act(async () => {
		resolve(2);
		await promise;
	});
	expect(container.textContent).toBe('2');
});
