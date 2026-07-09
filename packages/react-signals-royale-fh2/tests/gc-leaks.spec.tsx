// @vitest-environment jsdom
/**
 * Leak audit at the React level (requires --expose-gc): unmounted
 * subscribers release their handles; a full transition episode leaves the
 * engine quiescent; component-owned atoms reclaim after unmount.
 */
import { describe, expect, test, afterEach } from 'vitest';
import * as React from 'react';
import { atom, quiescent, set, __internals, type Atom } from 'signals-royale-fh2';
import { useAtom, useValue, startTransitionWrite } from '../src/index';
import { makeHarness, act, text, type Harness } from './helpers';

declare const gc: (() => void) | undefined;

let h: Harness;
afterEach(async () => {
	await h.cleanup();
});

async function collect(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		gc!();
		await new Promise((r) => setTimeout(r, 0));
	}
}


async function mountAndUnmountGarbage(h: Harness): Promise<WeakRef<object>> {
	const a = atom({ payload: new Array(500).fill(1) });
	function View() {
		return <span>{(useValue(a) as { payload: number[] }).payload.length}</span>;
	}
	const { root, container } = await h.mount(<View />);
	if (text(container) !== '500') {
		throw new Error('sanity');
	}
	await act(async () => {
		root.render(null);
	});
	await act(async () => {});
	// Unmount the root: a live FiberRoot retains its deleted subtree's hook
	// state (upstream React behavior); the engine itself holds nothing, as
	// the engine-package audit proves. Root disposal is the deterministic
	// reclamation edge the bindings rely on.
	await act(async () => {
		root.unmount();
	});
	h.roots.length = 0;
	return new WeakRef(a as object);
}

describe('gc / leaks (react)', () => {
	test('after unmount, a rendered atom handle reclaims (subscriptions and views release it)', async () => {
		expect(typeof gc).toBe('function');
		h = makeHarness();
		const ref = await mountAndUnmountGarbage(h);
		await collect();
		expect(ref.deref()).toBeUndefined();
	});

	test('a transition episode ends quiescent: no batches, no world caches', async () => {
		h = makeHarness();
		const a = atom(0);
		function View() {
			return <span>{useValue(a)}</span>;
		}
		const { container } = await h.mount(<View />);
		await act(async () => {
			startTransitionWrite(() => set(a, 1));
			set(a, 2);
		});
		await act(async () => {});
		expect(text(container)).toBe('2');
		expect(quiescent()).toBe(true);
		expect(__internals()).toEqual({ openBatches: 0, worldCaches: 0, pendingListeners: 0 });
	});

	test('useAtom: the component-owned atom reclaims after unmount', async () => {
		h = makeHarness();
		let ref: WeakRef<object> | null = null;
		function Owner() {
			const a = useAtom({ big: new Array(500).fill(2) });
			if (ref === null) {
				ref = new WeakRef(a as object);
			}
			return <span>{(useValue(a) as { big: number[] }).big.length}</span>;
		}
		const { root, container } = await h.mount(<Owner />);
		expect(text(container)).toBe('500');
		await act(async () => {
			root.render(null);
		});
		await act(async () => {});
		await collect();
		expect(ref!.deref()).toBeUndefined();
	});
});
