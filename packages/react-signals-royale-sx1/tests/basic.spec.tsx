import { afterEach, describe, expect, test } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { atom, batch, onDomMutation, set, startTransitionWrite, update, useValue } from '../src/index.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
	if (root !== undefined) await act(() => root!.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

async function mount(node: React.ReactNode): Promise<void> {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
	await act(() => root!.render(node));
}

describe('real React', () => {
	test('urgent writes and batches commit once', async () => {
		const a = atom(0);
		const b = atom(0);
		let renders = 0;
		function App() {
			renders++;
			return <>{useValue(a)},{useValue(b)}</>;
		}
		await mount(<App />);
		const before = renders;
		await act(() => batch(() => {
			set(a, 1);
			set(b, 2);
		}));
		expect(container!.textContent).toBe('1,2');
		expect(renders).toBe(before + 1);
	});

	test('transition reducer rebases over an urgent reducer', async () => {
		const value = atom(1);
		const blocked = atom(false);
		let gateResolve!: () => void;
		let pending = true;
		const gate = new Promise<void>(resolve => { gateResolve = resolve; });
		function App() {
			const current = useValue(value);
			if (useValue(blocked) && pending) throw gate;
			return <>{current}</>;
		}
		await mount(<React.Suspense fallback="wait"><App /></React.Suspense>);
		await act(async () => {
			startTransitionWrite(() => {
				update(value, x => x * 2);
				set(blocked, true);
			});
			flushSync(() => update(value, x => x + 1));
			expect(container!.textContent).toBe('2');
			pending = false;
			gateResolve();
		});
		expect(container!.textContent).toBe('4');
	});

	test('mutation events exactly bracket React DOM changes', async () => {
		const value = atom(0);
		const phases: string[] = [];
		const stop = onDomMutation(phase => phases.push(phase));
		function App() { return <span>{useValue(value)}</span>; }
		await mount(<App />);
		phases.length = 0;
		await act(() => set(value, 1));
		expect(phases).toEqual(['start', 'stop']);
		stop();
	});
});
