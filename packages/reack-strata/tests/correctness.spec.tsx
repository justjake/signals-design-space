// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Atom, installState } from 'strata-signals';
import { onDomMutation, resetForTest, useSignal } from '../src/index';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
	true;

let containers: HTMLDivElement[];
let roots: Root[];

beforeEach(() => {
	containers = [];
	roots = [];
});

afterEach(async () => {
	for (let i = 0; i < roots.length; i++) await act(() => roots[i]!.unmount());
	for (let i = 0; i < containers.length; i++) containers[i]!.remove();
	resetForTest();
});

function makeRoot(): [HTMLDivElement, Root] {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	containers.push(container);
	roots.push(root);
	return [container, root];
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test('flushSync excludes a pending transition branch', async () => {
	const [container, root] = makeRoot();
	const deferredValue = new Atom(0);
	const urgentValue = new Atom(0);

	function Reader() {
		return <span>{useSignal(deferredValue)}:{useSignal(urgentValue)}</span>;
	}

	await act(() => root.render(<Reader />));
	let middle = '';
	await act(async () => {
		React.startTransition(() => deferredValue.set(1));
		flushSync(() => urgentValue.set(2));
		middle = container.textContent ?? '';
	});
	expect(middle).toBe('0:2');
	expect(container.textContent).toBe('1:2');
});

test('siblings read one world in every commit', async () => {
	const [container, root] = makeRoot();
	const value = new Atom(0);
	const frames: string[] = [];

	function Reader({ id }: { id: string }) {
		return <span>{id}{useSignal(value)};</span>;
	}
	function App() {
		const frame = (
			<>
				<Reader id="a" />
				<Reader id="b" />
			</>
		);
		React.useLayoutEffect(() => {
			frames.push(container.textContent ?? '');
		});
		return frame;
	}

	await act(() => root.render(<App />));
	await act(() => React.startTransition(() => value.set(1)));
	for (let i = 0; i < frames.length; i++) {
		expect(['a0;b0;', 'a1;b1;']).toContain(frames[i]);
	}
});

test('an urgent mount sees committed state and joins the held transition later', async () => {
	const [container, root] = makeRoot();
	const value = new Atom('old');
	const shouldSuspend = new Atom(false);
	const gate = deferred<void>();
	let settled = false;
	void gate.promise.then(() => {
		settled = true;
	});
	let showLate!: React.Dispatch<React.SetStateAction<boolean>>;

	function Late() {
		return <b>late={useSignal(value)};</b>;
	}
	function App() {
		const [show, setShow] = React.useState(false);
		showLate = setShow;
		const current = useSignal(value);
		if (useSignal(shouldSuspend) && !settled) throw gate.promise;
		return <span>main={current};{show ? <Late /> : null}</span>;
	}

	await act(() =>
		root.render(
			<React.Suspense fallback={<i>waiting</i>}>
				<App />
			</React.Suspense>,
		),
	);
	await act(() => {
		React.startTransition(() => {
			value.set('new');
			shouldSuspend.set(true);
		});
	});
	expect(container.textContent).toBe('main=old;');

	flushSync(() => showLate(true));
	expect(container.textContent).toBe('main=old;late=old;');

	await act(async () => {
		gate.resolve();
		await gate.promise;
	});
	expect(container.textContent).toBe('main=new;late=new;');
});

test('one transition can commit independently across two roots', async () => {
	const [leftContainer, leftRoot] = makeRoot();
	const [rightContainer, rightRoot] = makeRoot();
	const value = new Atom(0);
	const shouldSuspend = new Atom(false);
	const gate = deferred<void>();
	let settled = false;
	void gate.promise.then(() => {
		settled = true;
	});

	function Left() {
		const current = useSignal(value);
		if (useSignal(shouldSuspend) && !settled) throw gate.promise;
		return <span>{current}</span>;
	}
	function Right() {
		return <span>{useSignal(value)}</span>;
	}

	await act(() => {
		leftRoot.render(<React.Suspense fallback="wait"><Left /></React.Suspense>);
		rightRoot.render(<Right />);
	});
	await act(() => {
		React.startTransition(() => {
			value.set(1);
			shouldSuspend.set(true);
		});
	});
	expect(leftContainer.textContent).toBe('0');
	expect(rightContainer.textContent).toBe('1');
	expect(value.state).toBe(0);

	await act(async () => {
		gate.resolve();
		await gate.promise;
	});
	expect(leftContainer.textContent).toBe('1');
	expect(value.state).toBe(1);
});

test('unmounted readers receive no further delivery', async () => {
	const [, root] = makeRoot();
	const value = new Atom(0);
	let renders = 0;
	function Reader() {
		renders++;
		return <span>{useSignal(value)}</span>;
	}
	await act(() => root.render(<Reader />));
	await act(() => root.render(null));
	const before = renders;
	await act(async () => {
		value.set(1);
		await Promise.resolve();
	});
	expect(renders).toBe(before);
});

test('a write during render fails before changing the atom', async () => {
	const [container, root] = makeRoot();
	const value = new Atom(0);
	class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
		state = { failed: false };
		static getDerivedStateFromError() {
			return { failed: true };
		}
		render() {
			return this.state.failed ? <span>failed</span> : this.props.children;
		}
	}
	function Writer() {
		value.set(1);
		return null;
	}
	await act(() => root.render(<Boundary><Writer /></Boundary>));
	expect(container.textContent).toBe('failed');
	expect(value.state).toBe(0);
});

test('mutation events bracket React mutations and can filter them from an observer', async () => {
	const [container, root] = makeRoot();
	const phases: string[] = [];
	const records: MutationRecord[] = [];
	const observer = new MutationObserver((next) => records.push(...next));
	observer.observe(container, { childList: true, characterData: true, subtree: true });
	const stop = onDomMutation((phase, changedContainer) => {
		if (changedContainer !== container) return;
		phases.push(phase);
		if (phase === 'start') observer.disconnect();
		else observer.observe(container, { childList: true, characterData: true, subtree: true });
	});

	await act(() => root.render(<span>React</span>));
	await Promise.resolve();
	expect(phases).toEqual(['start', 'stop']);
	expect(records).toHaveLength(0);

	container.append(document.createElement('i'));
	await Promise.resolve();
	expect(records.length).toBeGreaterThan(0);
	stop();
	observer.disconnect();
});

test('lazy state initializes on first render read and installState bypasses it', async () => {
	const [container, root] = makeRoot();
	let calls = 0;
	const lazy = new Atom(() => {
		calls++;
		return 3;
	});
	expect(calls).toBe(0);
	function Reader() {
		return <span>{useSignal(lazy)}</span>;
	}
	await act(() => root.render(<Reader />));
	expect(container.textContent).toBe('3');
	expect(calls).toBe(1);

	let skipped = 0;
	const hydrated = new Atom(() => {
		skipped++;
		return 1;
	});
	installState(hydrated, 9);
	expect(hydrated.state).toBe(9);
	expect(skipped).toBe(0);
});
