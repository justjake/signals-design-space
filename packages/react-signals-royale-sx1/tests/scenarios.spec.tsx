import { afterEach, describe, expect, test } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
	atom,
	computed,
	initializeAtomState,
	onDomMutation,
	refresh,
	serializeAtomState,
	set,
	startTransitionWrite,
	trace,
	useSignalEffect,
	useIsPending,
	useValue,
} from '../src/index.js';

type Mounted = { container: HTMLDivElement; root: Root };
const mounted: Mounted[] = [];

afterEach(async () => {
	for (const item of mounted.splice(0)) {
		await act(() => item.root.unmount());
		item.container.remove();
	}
});

async function mount(node: React.ReactNode): Promise<Mounted> {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.push({ container, root });
	await act(() => root.render(node));
	return { container, root };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

describe('concurrent scenarios', () => {
	test('pending transition stays out of committed DOM while pending flips urgently', async () => {
		const value = atom(0);
		const blocked = atom(false);
		const gate = deferred<void>();
		let waiting = true;
		function Content() {
			if (useValue(blocked) && waiting) throw gate.promise;
			return <b>{useValue(value)}</b>;
		}
		function App() {
			return <>{String(useIsPending(value))}:<React.Suspense fallback="fallback"><Content /></React.Suspense></>;
		}
		const view = await mount(<App />);
		await act(async () => {
			startTransitionWrite(() => {
				set(value, 1);
				set(blocked, true);
			});
			await Promise.resolve();
		});
		expect(view.container.textContent).toBe('true:0');
		waiting = false;
		await act(async () => gate.resolve());
		expect(view.container.textContent).toBe('false:1');
	});

	test('flushSync excludes a suspended transition and sibling readers do not tear', async () => {
		const draft = atom(0);
		const urgent = atom(0);
		const block = atom(false);
		const gate = deferred<void>();
		let waiting = true;
		function Pair() {
			const first = useValue(draft);
			const second = useValue(draft);
			if (useValue(block) && waiting) throw gate.promise;
			return <>{first}/{second}/{useValue(urgent)}</>;
		}
		const view = await mount(<React.Suspense fallback="wait"><Pair /></React.Suspense>);
		await act(async () => {
			startTransitionWrite(() => {
				set(draft, 1);
				set(block, true);
			});
			flushSync(() => set(urgent, 2));
			expect(view.container.textContent).toBe('0/0/2');
			waiting = false;
			gate.resolve();
		});
		expect(view.container.textContent).toBe('1/1/2');
	});

	test('a transition spans two roots consistently', async () => {
		const value = atom(0);
		function App() { return <>{useValue(value)}</>; }
		const first = await mount(<App />);
		const second = await mount(<App />);
		await act(() => startTransitionWrite(() => set(value, 1)));
		expect(first.container.textContent).toBe('1');
		expect(second.container.textContent).toBe('1');
	});

	test('a subscriber mounted inside a transition reads that world on its first render', async () => {
		const value = atom(0);
		let show!: (next: boolean) => void;
		let freshRenders = 0;
		function Fresh() { freshRenders++; return <i>{useValue(value)}</i>; }
		function App() {
			const [visible, setVisible] = React.useState(false);
			show = setVisible;
			return <>{useValue(value)}{visible ? <Fresh /> : null}</>;
		}
		const view = await mount(<App />);
		await act(() => startTransitionWrite(() => {
			set(value, 1);
			show(true);
		}));
		expect(view.container.textContent).toBe('11');
		expect(freshRenders).toBe(1);
	});

	test('a subscriber mounted into a suspending transition holds the old screen', async () => {
		const value = atom(0);
		const gate = deferred<void>();
		let waiting = true;
		let show!: (next: boolean) => void;
		function Reader() { return <b>{useValue(value)}</b>; }
		function Fresh() {
			const current = useValue(value);
			if (current === 1 && waiting) throw gate.promise;
			return <i>{current}</i>;
		}
		function App() {
			const [visible, setVisible] = React.useState(false);
			show = setVisible;
			return <><Reader /><React.Suspense fallback="fallback">{visible ? <Fresh /> : null}</React.Suspense></>;
		}
		const view = await mount(<App />);
		await act(async () => {
			startTransitionWrite(() => {
				set(value, 1);
				show(true);
			});
			await Promise.resolve();
		});
		expect(view.container.textContent).toBe('0');
		waiting = false;
		await act(async () => gate.resolve());
		expect(view.container.textContent).toBe('11');
	});

	test('urgent branch update rebases before the pending transition reducer', async () => {
		const value = atom(1);
		const log = trace();
		const block = atom(false);
		const gate = deferred<void>();
		let waiting = true;
		function App() {
			const current = useValue(value);
			if (useValue(block) && waiting) throw gate.promise;
			return <>{current}</>;
		}
		const view = await mount(<React.Suspense fallback="wait"><App /></React.Suspense>);
		await act(async () => {
			startTransitionWrite(() => {
				value.update(current => current * 3);
				set(block, true);
			});
			flushSync(() => value.update(current => current * 2));
			expect(view.container.textContent).toBe('2');
			waiting = false;
			gate.resolve();
		});
		expect(view.container.textContent).toBe('6');
		const writes = log.events().filter(event => event.kind === 'write' && event.node === value.id);
		expect(log.whyLastDelivery(value)).toContain(`write#${writes[0].id}`);
		log.stop();
	});

	test('StrictMode nets one lifetime observation and unmount stops deliveries', async () => {
		let starts = 0;
		let stops = 0;
		let renders = 0;
		const value = atom(0, { effect: () => {
			starts++;
			return () => { stops++; };
		} });
		function App() { renders++; return <>{useValue(value)}</>; }
		const view = await mount(<React.StrictMode><App /></React.StrictMode>);
		await act(async () => Promise.resolve());
		expect({ starts, stops }).toEqual({ starts: 1, stops: 0 });
		await act(() => view.root.unmount());
		mounted.splice(mounted.indexOf(view), 1);
		await Promise.resolve();
		const before = renders;
		set(value, 1);
		expect(renders).toBe(before);
		expect(stops).toBe(1);
	});

	test('write during render fails loudly', async () => {
		const value = atom(0);
		function Invalid() {
			set(value, 1);
			return null;
		}
		await expect(mount(<Invalid />)).rejects.toThrow('while React is rendering');
	});

	test('signal effects rerun on committed changes and clean up', async () => {
		const value = atom(0);
		const events: string[] = [];
		function App() {
			useSignalEffect(() => {
				events.push(`run:${value.read()}`);
				return () => events.push('cleanup');
			});
			return <>{useValue(value)}</>;
		}
		const view = await mount(<App />);
		await act(() => set(value, 1));
		await act(() => view.root.unmount());
		mounted.splice(mounted.findIndex(item => item.root === view.root), 1);
		expect(events).toEqual(['run:0', 'cleanup', 'run:1', 'cleanup']);
	});

	test('first async load suspends once and refresh serves stale content', async () => {
		let request = deferred<number>();
		let fetches = 0;
		const value = computed(use => {
			fetches++;
			return use(request.promise);
		});
		function App() { return <>{String(useIsPending(value))}:{useValue(value)}</>; }
		const view = await mount(<React.Suspense fallback="loading"><App /></React.Suspense>);
		expect(view.container.textContent).toBe('loading');
		await act(async () => request.resolve(1));
		expect(view.container.textContent).toBe('false:1');
		expect(fetches).toBe(2);
		request = deferred<number>();
		await act(() => refresh(value));
		expect(view.container.textContent).toBe('true:1');
		await act(async () => request.resolve(2));
		expect(view.container.textContent).toBe('false:2');
	});

	test('refresh settlement stays in its transition without a fallback flash', async () => {
		let request = deferred<number>();
		const value = computed(use => use(request.promise));
		function App() { return <>{useValue(value)}</>; }
		const view = await mount(<React.Suspense fallback="loading"><App /></React.Suspense>);
		await act(async () => request.resolve(1));
		request = deferred<number>();
		await act(async () => {
			startTransitionWrite(() => refresh(value));
			await Promise.resolve();
		});
		expect(view.container.textContent).toBe('1');
		await act(async () => request.resolve(2));
		expect(view.container.textContent).toBe('2');
	});

	test('causality and the MutationObserver exclusion window are observable', async () => {
		const value = atom(0);
		const log = trace();
		const seen: string[] = [];
		let observer: MutationObserver;
		const stop = onDomMutation(phase => {
			if (phase === 'start') observer.disconnect();
			else observer.observe(document.body, { childList: true, subtree: true, characterData: true });
		});
		observer = new MutationObserver(records => seen.push(...records.map(record => record.type)));
		observer.observe(document.body, { childList: true, subtree: true, characterData: true });
		function App() { return <span>{useValue(value)}</span>; }
		await mount(<App />);
		seen.length = 0;
		await act(() => set(value, 1));
		document.body.appendChild(document.createElement('i'));
		await Promise.resolve();
		expect(seen).toEqual(['childList']);
		expect(log.whyLastDelivery(value).some(line => line.startsWith('write#'))).toBe(true);
		observer.disconnect();
		stop();
		log.stop();
	});

	test('SSR install produces the first client value without correction', async () => {
		const server = atom(9, { label: 'count' });
		const json = serializeAtomState([server as ReturnType<typeof atom<unknown>>]);
		let initialized = 0;
		const client = atom(() => ++initialized, { label: 'count' });
		initializeAtomState(json, [client as ReturnType<typeof atom<unknown>>]);
		let renders = 0;
		function App() { renders++; return <>{useValue(client)}</>; }
		const view = await mount(<App />);
		expect(view.container.textContent).toBe('9');
		expect({ initialized, renders }).toEqual({ initialized: 0, renders: 1 });
	});

	test('lazy initialization happens at render read and before a pre-render set', async () => {
		let calls = 0;
		const first = atom(() => ++calls);
		function First() { return <>{useValue(first)}</>; }
		const firstView = await mount(<First />);
		expect(firstView.container.textContent).toBe('1');
		const second = atom(() => ++calls);
		set(second, 8);
		function Second() { return <>{useValue(second)}</>; }
		const secondView = await mount(<Second />);
		expect(secondView.container.textContent).toBe('8');
		expect(calls).toBe(2);
	});
});
