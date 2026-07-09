// @vitest-environment jsdom
/** Binding-level coverage beyond the battery: the remaining hooks, loud
 * registration failure, and reclamation of dropped React-side handles. */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, set, type Atom } from 'signals-royale-fm2';
import {
	register,
	resetForTest,
	useAtom,
	useComputed,
	useCommitted,
	useSignalEffect,
	useValue,
} from '../src/index';

declare const gc: () => void;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
let containers: HTMLElement[] = [];

beforeEach(() => {
	register();
});
afterEach(async () => {
	await act(async () => {
		for (const r of roots) r.unmount();
	});
	for (const c of containers) c.remove();
	roots = [];
	containers = [];
	resetForTest();
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	containers.push(container);
	await act(() => {
		root.render(node);
	});
	return container;
}

const text = (c: HTMLElement) => (c.textContent ?? '').replace(/\s+/g, '');

describe('useComputed', () => {
	test('derives from signals read inside fn and updates on writes', async () => {
		const a = atom(2);
		function App() {
			const doubled = useComputed(() => a.get() * 2, []);
			return <span>{doubled}</span>;
		}
		const c = await mount(<App />);
		expect(text(c)).toBe('4');
		await act(async () => {
			set(a, 5);
		});
		expect(text(c)).toBe('10');
	});
});

describe('useSignalEffect', () => {
	test('runs on committed changes; cleanup honored; stops after unmount', async () => {
		const a = atom(0);
		const log: string[] = [];
		function App() {
			useSignalEffect(() => {
				const v = a.get();
				log.push(`run:${v}`);
				return () => log.push(`clean:${v}`);
			});
			return null;
		}
		await mount(<App />);
		expect(log).toEqual(['run:0']);
		await act(async () => {
			set(a, 1);
		});
		expect(log).toEqual(['run:0', 'clean:0', 'run:1']);
		await act(async () => {
			roots[0].unmount();
		});
		log.length = 0;
		await act(async () => {
			set(a, 2);
		});
		expect(log).toEqual([]);
	});
});

describe('useAtom', () => {
	test('component-owned atom is stable across re-renders', async () => {
		const seen = new Set<Atom<number>>();
		const outer = atom(0);
		function App() {
			const own = useAtom(1);
			seen.add(own);
			useValue(outer); // re-render driver
			return <span>{useValue(own)}</span>;
		}
		const c = await mount(<App />);
		await act(async () => {
			set(outer, 1);
		});
		expect(text(c)).toBe('1');
		expect(seen.size).toBe(1);
	});
});

describe('useCommitted', () => {
	test('tracks what this root committed, catching up at the next commit', async () => {
		const a = atom(1);
		function App() {
			return (
				<span>
					v:{useValue(a)};c:{useCommitted(a) as number};
				</span>
			);
		}
		const c = await mount(<App />);
		expect(text(c)).toBe('v:1;c:1;');
		await act(async () => {
			set(a, 2);
		});
		expect(text(c)).toBe('v:2;c:2;');
	});
});

describe('registration', () => {
	test('fails loudly when the host protocol is missing (stock React)', () => {
		const internals = (
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(await0() as any)
		)['__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'];
		const saved = internals.royaleProbeLane;
		internals.royaleProbeLane = undefined;
		try {
			expect(() => register()).toThrow(/does not expose the royale host protocol/);
		} finally {
			internals.royaleProbeLane = saved;
		}
	});
});

// Small indirection so the import stays at module top.
import * as ReactNS from 'react';
function await0(): typeof ReactNS {
	return ReactNS;
}

describe('reclamation', () => {
	test('unmounted subscribers and dropped atoms are collected', async () => {
		const refs: WeakRef<object>[] = [];
		async function episode(): Promise<void> {
			const a = atom(0);
			refs.push(new WeakRef(a));
			function App() {
				return <span>{useValue(a)}</span>;
			}
			const container = document.createElement('div');
			document.body.appendChild(container);
			const root = createRoot(container);
			await act(() => {
				root.render(<App />);
			});
			await act(async () => {
				set(a, 1);
			});
			await act(() => {
				root.unmount();
			});
			container.remove();
		}
		await episode();
		let clean = false;
		for (let i = 0; i < 10 && !clean; i++) {
			gc();
			await new Promise((r) => setTimeout(r, 0));
			gc();
			clean = refs.every((r) => r.deref() === undefined);
			await new Promise((r) => setTimeout(r, 0));
		}
		expect(clean).toBe(true);
	});
});
