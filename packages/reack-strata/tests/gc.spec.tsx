// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, test } from 'vitest';
import { type Atom } from 'strata-signals';
import { resetForTest, useAtom, useSignal } from '../src/index.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
	true;

async function collect<T extends object>(reference: WeakRef<T>): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	for (let i = 0; i < 40; i++) {
		global.gc!();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	void reference;
}

test('an unmounted component-owned atom and subscription are reclaimable', async () => {
	let reference!: WeakRef<Atom<number>>;
	let container: HTMLDivElement | undefined = document.createElement('div');
	const containerReference = new WeakRef(container);
	let root: Root | undefined = createRoot(container);

	function App() {
		const value = useAtom(1);
		reference ??= new WeakRef(value);
		return <span>{useSignal(value)}</span>;
	}

	await act(() => root!.render(<App />));
	await act(() => root!.unmount());
	root = undefined;
	container = undefined;
	await collect(reference);
	expect(reference.deref()).toBeUndefined();
	expect(containerReference.deref()).toBeUndefined();
	resetForTest();
});
