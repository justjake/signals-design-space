// @vitest-environment jsdom
// Zero-signals control: urgent-lane React.use(pendingPromise) retry, in the
// exact environment the alt-a RTL suite uses (act + jsdom + vitest).
import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function mount(node: React.ReactNode): { container: HTMLElement; root: Root } {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(node);
	});
	return { container, root };
}

describe('zero-signals urgent use(P) control', () => {
	it('URGENT mount: use(pending promise) retries after resolve', async () => {
		const { promise, resolve } = deferred<string>();
		function Content(): React.ReactNode {
			return <span>{React.use(promise)}</span>;
		}
		const { container } = mount(
			<React.Suspense fallback={<i>loading</i>}>
				<Content />
			</React.Suspense>,
		);
		expect(container.textContent).toBe('loading');
		await act(async () => {
			resolve('done');
			await tick();
			await tick();
		});
		expect(container.textContent).toBe('done');
	});

	it('URGENT update: setState reveals use(pending promise), retries after resolve', async () => {
		const { promise, resolve } = deferred<string>();
		let setShow!: (v: boolean) => void;
		function Content(): React.ReactNode {
			return <span>{React.use(promise)}</span>;
		}
		function App(): React.ReactNode {
			const [show, set] = React.useState(false);
			setShow = set;
			return show ? (
				<React.Suspense fallback={<i>loading</i>}>
					<Content />
				</React.Suspense>
			) : (
				<span>idle</span>
			);
		}
		const { container } = mount(<App />);
		expect(container.textContent).toBe('idle');
		await act(async () => {
			setShow(true);
		});
		expect(container.textContent).toBe('loading');
		await act(async () => {
			resolve('done');
			await tick();
			await tick();
		});
		expect(container.textContent).toBe('done');
	});

	it('TRANSITION control: startTransition reveals use(pending promise), retries after resolve', async () => {
		const { promise, resolve } = deferred<string>();
		let setShow!: (v: boolean) => void;
		function Content(): React.ReactNode {
			return <span>{React.use(promise)}</span>;
		}
		function App(): React.ReactNode {
			const [show, set] = React.useState(false);
			setShow = set;
			return (
				<React.Suspense fallback={<i>loading</i>}>
					{show ? <Content /> : <span>idle</span>}
				</React.Suspense>
			);
		}
		const { container } = mount(<App />);
		await act(async () => {
			React.startTransition(() => setShow(true));
			await tick();
		});
		await act(async () => {
			resolve('done');
			await tick();
			await tick();
		});
		expect(container.textContent).toBe('done');
	});

	it('THROWN-THENABLE control: urgent mount with legacy thrown promise retries', async () => {
		const { promise, resolve } = deferred<string>();
		let value: string | undefined;
		void promise.then((v) => (value = v));
		function Content(): React.ReactNode {
			if (value === undefined) {
				throw promise;
			}
			return <span>{value}</span>;
		}
		const { container } = mount(
			<React.Suspense fallback={<i>loading</i>}>
				<Content />
			</React.Suspense>,
		);
		expect(container.textContent).toBe('loading');
		await act(async () => {
			resolve('done');
			await tick();
			await tick();
		});
		expect(container.textContent).toBe('done');
	});
});
