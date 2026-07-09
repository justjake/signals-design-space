// @vitest-environment jsdom
/**
 * Real-React gate, scenarios 11-18: suspense, branch state, lifetime
 * effects, causality, the DOM mutation window, lazy initializers, SSR.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { flushSync } from 'react-dom';
import {
	atom,
	computed,
	initializeAtomState,
	refresh,
	serializeAtomState,
	set,
	startTransitionWrite,
	trace,
	update,
	useIsPending,
	useValue,
} from '../src/index.ts';
import { act, makeHarness, React, tick } from './helpers.tsx';

let harness = makeHarness();
afterEach(async () => {
	await harness.cleanup();
	harness = makeHarness();
});

describe('11. suspense', () => {
	test('first load: fallback then converge; fetch count stays 1 across retries', async () => {
		let fetches = 0;
		let release!: (v: string) => void;
		const source = atom(
			() =>
				new Promise<string>((r) => {
					fetches++;
					release = r;
				}),
			{ label: 'source' },
		);
		const data = computed((use) => use(source.get()), { label: 'data' });
		function View() {
			return <span>{useValue(data)}</span>;
		}
		const { container } = await harness.mount(
			<React.Suspense fallback={<i>loading</i>}>
				<View />
			</React.Suspense>,
		);
		expect(container.textContent).toBe('loading');
		await act(async () => {
			release('ready');
			await tick();
		});
		expect(container.textContent).toBe('ready');
		expect(fetches).toBe(1);
	});

	test('refresh: stale content + isPending, no fallback flash', async () => {
		let fetches = 0;
		let release!: (v: string) => void;
		let inflight: Promise<string> | null = null;
		const data = computed(
			(use) => {
				if (fetches === 0) {
					fetches++;
					return 'first';
				}
				if (inflight === null) {
					fetches++;
					inflight = new Promise<string>((r) => (release = r));
				}
				return use(inflight);
			},
			{ label: 'data' },
		);
		const domHistory: string[] = [];
		function View() {
			const value = useValue(data);
			const pending = useIsPending(data);
			return (
				<span>
					{value}:{pending ? 'pending' : 'idle'}
				</span>
			);
		}
		const { container } = await harness.mount(
			<React.Suspense fallback={<i>fallback</i>}>
				<View />
			</React.Suspense>,
		);
		expect(container.textContent).toBe('first:idle');
		await act(async () => {
			refresh(data);
			await tick();
		});
		domHistory.push(container.textContent!);
		// Stale content kept serving; the pending probe is the indicator; the
		// fallback never flashed (the content span never left the DOM).
		expect(domHistory[0]).toBe('first:pending');
		await act(async () => {
			release('second');
			await tick();
		});
		expect(container.textContent).toBe('second:idle');
		expect(fetches).toBe(2);
	});
});

describe('12. time slicing', () => {
	test('urgent write lands while a large transition is still rendering', async () => {
		// Without act: real scheduler timing, raw createRoot, so the transition
		// render actually yields and the urgent update interrupts it.
		(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
		try {
			const urgent = atom(0, { label: 'urgent' });
			const size = atom(10, { label: 'size' });
			function Row({ i }: { i: number }) {
				const n = useValue(size);
				// Enough work per row that a 3000-row pass must yield.
				let x = 0;
				for (let k = 0; k < 2000; k++) x += (k * n) % 7;
				return <i data-x={x % 2}>{i}</i>;
			}
			function App() {
				const n = useValue(size);
				const u = useValue(urgent);
				return (
					<div>
						<b>{u}</b>
						{Array.from({ length: n }, (_, i) => (
							<Row key={i} i={i} />
						))}
					</div>
				);
			}
			const { root, container } = harness.newRoot();
			flushSync(() => {
				root.render(<App />);
			});
			expect(container.querySelectorAll('i').length).toBe(10);
			startTransitionWrite(() => {
				set(size, 3000);
			});
			// Give the transition a moment to start rendering, then interrupt.
			await new Promise((r) => setTimeout(r, 5));
			const rowsAtInterrupt = container.querySelectorAll('i').length;
			flushSync(() => {
				set(urgent, 1);
			});
			const urgentText = container.querySelector('b')!.textContent;
			const rowsAtUrgentCommit = container.querySelectorAll('i').length;
			// The urgent update committed while the transition had not.
			expect(urgentText).toBe('1');
			expect(rowsAtInterrupt).toBe(10);
			expect(rowsAtUrgentCommit).toBe(10);
			// The transition eventually lands with the urgent value intact.
			for (let i = 0; i < 400 && container.querySelectorAll('i').length !== 3000; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(container.querySelectorAll('i').length).toBe(3000);
			expect(container.querySelector('b')!.textContent).toBe('1');
			flushSync(() => root.unmount());
		} finally {
			(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
		}
	}, 30_000);
});

describe('13. branch state', () => {
	test('urgent x2 shows 2 now, 6 after the transition x3 lands; never 3, never 4', async () => {
		const counter = atom(1, { label: 'counter' });
		const domHistory: string[] = [];
		function View() {
			return <span>{useValue(counter)}</span>;
		}
		const { container } = await harness.mount(<View />);
		domHistory.push(container.textContent!);
		await act(async () => {
			startTransitionWrite(() => {
				update(counter, (x) => x * 3);
			});
			flushSync(() => {
				update(counter, (x) => x * 2);
			});
			domHistory.push(container.textContent!);
			await tick();
		});
		domHistory.push(container.textContent!);
		expect(domHistory).toEqual(['1', '2', '6']);
	});
});

describe('14. lifetime effect', () => {
	test('first render subscriber mounts the observation, last unmount cleans up', async () => {
		const log: string[] = [];
		const a = atom(0, {
			label: 'a',
			onObserved: () => {
				log.push('open');
				return () => log.push('close');
			},
		});
		function View() {
			return <span>{useValue(a)}</span>;
		}
		const { root } = await harness.mount(
			<div>
				<View />
				<View />
			</div>,
		);
		await act(async () => {
			await tick();
		});
		expect(log).toEqual(['open']);
		await act(async () => {
			root.unmount();
			await tick();
		});
		expect(log).toEqual(['open', 'close']);
	});
});

describe('15. causality', () => {
	test('the trace explains urgent and post-retirement re-renders', async () => {
		const a = atom(1, { label: 'traced' });
		function View() {
			return <span>{useValue(a)}</span>;
		}
		await harness.mount(<View />);
		const view = trace();
		try {
			await act(async () => {
				startTransitionWrite(() => {
					update(a, (x) => x * 2);
				});
				flushSync(() => {
					update(a, (x) => x + 1);
				});
				await tick();
			});
			const chain = view.whyLastDelivery(a);
			const joined = chain.join('\n');
			// The delivery chains back to a draft write inside the batch.
			expect(joined).toMatch(/deliver/);
			expect(joined).toMatch(/draft-write|write/);
			// The event stream shows the batch lifecycle with causal parents.
			const kinds = view.events().map((e) => e.kind);
			expect(kinds).toContain('batch-open');
			expect(kinds).toContain('batch-commit');
			expect(kinds).toContain('write');
			const commit = view.events().find((e) => e.kind === 'batch-commit')!;
			expect(commit.cause).toBeDefined();
		} finally {
			view.stop();
		}
	});
});

describe('16. DOM mutation window', () => {
	test('a MutationObserver that pauses across the window sees only third-party mutations', async () => {
		const { onDomMutation } = await import('../src/index.ts');
		const a = atom(0, { label: 'a' });
		function View() {
			return <span>{useValue(a)}</span>;
		}
		const { container } = await harness.mount(<View />);
		const reactMutations: MutationRecord[] = [];
		const observer = new MutationObserver((records) => reactMutations.push(...records));
		observer.observe(container, { childList: true, characterData: true, subtree: true });
		const dispose = onDomMutation((phase, mutatedContainer) => {
			if (mutatedContainer !== container) return;
			if (phase === 'start') {
				// Absorb anything already queued, then stop watching while React
				// mutates.
				reactMutations.push(...observer.takeRecords());
				observer.disconnect();
			} else {
				observer.observe(container, {
					childList: true,
					characterData: true,
					subtree: true,
				});
			}
		});
		try {
			const before = reactMutations.length;
			await act(async () => {
				set(a, 1);
			});
			expect(container.textContent).toBe('1');
			// React's own mutation was invisible to the observer.
			reactMutations.push(...observer.takeRecords());
			expect(reactMutations.length).toBe(before);
			// A third-party mutation is still caught.
			container.appendChild(document.createElement('em'));
			await tick();
			reactMutations.push(...observer.takeRecords());
			expect(reactMutations.length).toBeGreaterThan(before);
		} finally {
			dispose();
			observer.disconnect();
		}
	});
});

describe('17. lazy initializer', () => {
	test('initializer runs at first render read', async () => {
		let runs = 0;
		const a = atom(() => {
			runs++;
			return 'lazy';
		});
		function View() {
			return <span>{useValue(a)}</span>;
		}
		expect(runs).toBe(0);
		const { container } = await harness.mount(<View />);
		expect(container.textContent).toBe('lazy');
		expect(runs).toBe(1);
	});

	test('set before first read runs the initializer first', () => {
		let runs = 0;
		const a = atom(
			() => {
				runs++;
				return 10;
			},
			{ label: 'a' },
		);
		set(a, 10);
		expect(runs).toBe(1);
		expect(a.version).toBe(1); // the equal write dropped against the base
	});
});

describe('18. SSR', () => {
	test('serialize -> installState -> first client render matches, zero corrective re-renders', async () => {
		// Server side: atoms with live values.
		const serverCount = atom(41, { label: 'count' });
		set(serverCount, 42);
		const json = serializeAtomState({ count: serverCount });

		// Client side: fresh atoms with lazy initializers that must NOT run.
		let initializerRuns = 0;
		const clientCount = atom(
			() => {
				initializerRuns++;
				return 0;
			},
			{ label: 'count' },
		);
		initializeAtomState(json, { count: clientCount });
		expect(initializerRuns).toBe(0);

		let renders = 0;
		function View() {
			renders++;
			return <span>{useValue(clientCount)}</span>;
		}
		const { container } = await harness.mount(<View />);
		expect(container.textContent).toBe('42');
		await act(async () => {
			await tick();
		});
		expect(renders).toBe(1);
	});
});
