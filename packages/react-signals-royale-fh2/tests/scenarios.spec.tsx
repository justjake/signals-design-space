// @vitest-environment jsdom
/**
 * The real-React gate, part 1: concurrency scenarios (RULES 1-10, 12, 13,
 * 17) against this package's own fork build via raw createRoot + act.
 */
import { describe, expect, test, afterEach } from 'vitest';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { atom, computed, read, latest, committed, set, update, type Atom } from 'signals-royale-fh2';
import { useValue, useComputed, useIsPending, startTransitionWrite } from '../src/index';
import { makeHarness, act, text, deferred, tick, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
	await h.cleanup();
});

function Reader({ id, a }: { id: string; a: Atom<number> }) {
	return (
		<span>
			{id}:{useValue(a)};
		</span>
	);
}

describe('scenario 1 — commit coalescing', () => {
	test('one urgent write: one commit; grouped handler writes: one commit', async () => {
		h = makeHarness();
		const a = atom(0);
		const b = atom(0);
		let renders = 0;
		function Both() {
			renders++;
			return (
				<span>
					{useValue(a)},{useValue(b)}
				</span>
			);
		}
		const { container } = await h.mount(<Both />);
		let before = renders;
		await act(async () => {
			set(a, 1);
		});
		expect(text(container)).toBe('1,0');
		expect(renders).toBe(before + 1);
		before = renders;
		await act(async () => {
			set(a, 2);
			set(b, 2);
		});
		expect(text(container)).toBe('2,2');
		expect(renders).toBe(before + 1);
	});
});

describe('scenarios 2 + 3 + 13 — transitions: invisibility, isPending, rebase', () => {
	function makeHeld() {
		const a = atom(1);
		const hold = atom(false);
		const gate = deferred<void>();
		function Suspender() {
			const v = useValue(a);
			const held = useValue(hold);
			if (held && !gate.settled) throw gate.promise;
			return <span>v:{v};</span>;
		}
		return { a, hold, gate, Suspender };
	}

	test('pending transition state never reaches the committed DOM; the read family agrees', async () => {
		h = makeHarness();
		const { a, hold, gate, Suspender } = makeHeld();
		const { container } = await h.mount(
			<React.Suspense fallback={<i>fb;</i>}>
				<Suspender />
			</React.Suspense>,
		);
		expect(text(container)).toBe('v:1;');
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 5);
				set(hold, true);
			});
		});
		expect(text(container)).toBe('v:1;'); // held: no leak, no fallback
		expect(read(a)).toBe(1); // canonical hides drafts
		expect(committed(a)).toBe(1);
		expect(latest(a)).toBe(5); // newest intent includes the draft
		gate.settled = true;
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('v:5;');
	});

	test('useIsPending flips while the transition is pending', async () => {
		h = makeHarness();
		const { a, hold, gate, Suspender } = makeHeld();
		function Probe() {
			return <em>{useIsPending(a) ? 'P' : 'i'};</em>;
		}
		const { container } = await h.mount(
			<>
				<Probe />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		expect(text(container)).toBe('i;v:1;');
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 5);
				set(hold, true);
			});
		});
		expect(text(container)).toBe('P;v:1;');
		gate.settled = true;
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('i;v:5;');
	});

	test('urgent double over a pending transition: 1 -> 2 -> 6, never 3, never 4', async () => {
		h = makeHarness();
		const { a, hold, gate, Suspender } = makeHeld();
		const frames: number[] = [];
		function Watch() {
			const v = useValue(a);
			React.useLayoutEffect(() => {
				frames.push(v);
			});
			return <b>w:{v};</b>;
		}
		const { container } = await h.mount(
			<>
				<Watch />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		await act(async () => {
			startTransitionWrite(() => {
				update(a, (x) => x + 2);
				set(hold, true);
			});
		});
		expect(text(container)).toBe('w:1;v:1;');
		await act(async () => {
			update(a, (x) => x * 2); // urgent: commits alone
		});
		// The suspender is a committed subscriber too: the urgent write
		// re-renders it canonically (its hold flag is only draft-true).
		expect(text(container)).toBe('w:2;v:2;');
		expect(read(a)).toBe(2);
		gate.settled = true;
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('w:6;v:6;'); // (1+2)*2: replay, not reorder
		const collapsed = frames.filter((v, i) => i === 0 || v !== frames[i - 1]);
		expect(collapsed).toEqual([1, 2, 6]);
	});
});

describe('scenario 4 — sibling consistency', () => {
	test('pairs of reads agree in every render, including interleaved transitions', async () => {
		h = makeHarness();
		const a = atom(0);
		const pairs: Array<[number, number]> = [];
		function Pair() {
			const v1 = useValue(a);
			const v2 = useValue(a);
			pairs.push([v1, v2]);
			return (
				<span>
					{v1},{v2};
				</span>
			);
		}
		const { container } = await h.mount(
			<>
				<Pair />
				<Pair />
			</>,
		);
		await act(async () => {
			set(a, 1);
			startTransitionWrite(() => set(a, 2));
		});
		await act(async () => {});
		expect(text(container)).toBe('2,2;2,2;');
		for (const [v1, v2] of pairs) {
			expect(v1).toBe(v2);
		}
	});
});

describe('scenario 5 — mount mid-transition', () => {
	test('late mount shows committed value, then joins the transition commit (suspending variant holds)', async () => {
		h = makeHarness();
		const a = atom(0);
		const gate = deferred<void>();
		function Suspender() {
			const v = useValue(a);
			if (v > 0 && !gate.settled) throw gate.promise;
			return <span>s:{v};</span>;
		}
		function App({ extra }: { extra: boolean }) {
			return (
				<>
					<Reader id="r1" a={a} />
					<React.Suspense fallback={<span>fb;</span>}>
						<Suspender />
					</React.Suspense>
					{extra ? <Reader id="r2" a={a} /> : null}
				</>
			);
		}
		const { root, container } = await h.mount(<App extra={false} />);
		await act(async () => {
			startTransitionWrite(() => set(a, 1));
		});
		expect(text(container)).toBe('r1:0;s:0;'); // held, no fallback
		await act(async () => {
			root.render(<App extra={true} />); // urgent mount mid-transition
		});
		expect(text(container)).toBe('r1:0;s:0;r2:0;'); // committed world, no tear
		gate.settled = true;
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('r1:1;s:1;r2:1;'); // r2 joined the same commit
	});
});

describe('scenario 6 — flushSync excludes deferred work', () => {
	test('a flushSync commit never carries the pending transition batch', async () => {
		h = makeHarness();
		const a = atom(0);
		const b = atom(0);
		const gate = deferred<void>();
		function Suspender() {
			const v = useValue(a);
			if (v > 0 && !gate.settled) throw gate.promise;
			return <span>s:{v};</span>;
		}
		const { container } = await h.mount(
			<>
				<Reader id="a" a={a} />
				<Reader id="b" a={b} />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		await act(async () => {
			startTransitionWrite(() => set(a, 9));
		});
		await act(async () => {
			flushSync(() => set(b, 1));
			expect(text(container)).toBe('a:0;b:1;s:0;');
		});
		gate.settled = true;
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('a:9;b:1;s:9;');
	});
});

describe('scenario 7 — one transition across two roots', () => {
	test('both roots converge; a hold on one root leaves the other committed; per-root views diverge then join', async () => {
		h = makeHarness();
		const a = atom(0);
		const gate = deferred<void>();
		function Suspender() {
			const v = useValue(a);
			if (v > 0 && !gate.settled) throw gate.promise;
			return <span>s:{v};</span>;
		}
		const one = await h.mount(
			<React.Suspense fallback={null}>
				<Suspender />
			</React.Suspense>,
		);
		const two = await h.mount(<Reader id="r" a={a} />);
		await act(async () => {
			startTransitionWrite(() => set(a, 1));
		});
		expect(text(one.container)).toBe('s:0;'); // held here
		expect(text(two.container)).toBe('r:1;'); // committed there
		expect(committed(a, one.container)).toBe(0);
		expect(committed(a, two.container)).toBe(1);
		gate.settled = true;
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(one.container)).toBe('s:1;');
		expect(committed(a, one.container)).toBe(1);
	});
});

describe('scenarios 8 + 9 — StrictMode netting and unmount silence', () => {
	test('StrictMode double-mount nets one lifetime observation; subscription survives; unmount cleans up', async () => {
		h = makeHarness();
		const log: string[] = [];
		const a = atom(0);
		const observed = atom(0, {
			effect: () => {
				log.push('observe');
				return () => log.push('unobserve');
			},
		});
		function App() {
			return (
				<span>
					{useValue(a)}:{useValue(observed)}
				</span>
			);
		}
		const { root, container } = await h.mount(
			<React.StrictMode>
				<App />
			</React.StrictMode>,
		);
		await act(async () => {});
		expect(log).toEqual(['observe']);
		await act(async () => {
			set(a, 2);
		});
		expect(text(container)).toBe('2:0');
		await act(async () => {
			root.render(null);
		});
		await act(async () => {});
		expect(log).toEqual(['observe', 'unobserve']);
	});

	test('unmounted subscribers receive nothing', async () => {
		h = makeHarness();
		const a = atom(0);
		let renders = 0;
		function View() {
			renders++;
			return <span>{useValue(a)}</span>;
		}
		const { root } = await h.mount(<View />);
		await act(async () => {
			root.render(<div />);
		});
		await act(async () => {});
		const before = renders;
		await act(async () => {
			set(a, 1);
			startTransitionWrite(() => set(a, 2));
		});
		await act(async () => {});
		expect(renders).toBe(before);
	});
});

describe('scenario 10 — write-during-render fails loudly', () => {
	test('set() from a component body throws synchronously', async () => {
		h = makeHarness();
		const a = atom(0);
		let thrown: unknown;
		function Bad() {
			const v = useValue(a);
			if (v === 0) {
				try {
					set(a, 1);
				} catch (e) {
					thrown = e;
				}
			}
			return <span>{v}</span>;
		}
		const { container } = await h.mount(<Bad />);
		expect(String(thrown)).toMatch(/during render/);
		expect(text(container)).toBe('0');
	});
});

describe('scenario 12 — time slicing: urgent input stays responsive', () => {
	test('a flushSync commit lands while the transition render is mid-flight; the transition still lands', async () => {
		h = makeHarness();
		const items = atom(0);
		const urgent = atom(0);
		let itemRenders = 0;
		function SlowItem({ k }: { k: number }) {
			itemRenders++;
			const end = performance.now() + 4;
			while (performance.now() < end) {
				// burn most of one slice so the list spans many slices
			}
			return <i>{k},</i>;
		}
		function List() {
			const n = useValue(items);
			const kids: React.ReactNode[] = [];
			for (let k = 0; k < n; k++) {
				kids.push(<SlowItem key={k} k={k} />);
			}
			return (
				<div>
					n:{n};{kids}
				</div>
			);
		}
		function Input() {
			return <b>u:{useValue(urgent)};</b>;
		}
		const { container } = await h.mount(
			<>
				<Input />
				<List />
			</>,
		);
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
		try {
			startTransitionWrite(() => set(items, 24));
			const deadline = Date.now() + 5000;
			while (itemRenders < 3 && Date.now() < deadline) {
				await tick(5);
			}
			expect(itemRenders).toBeGreaterThanOrEqual(3);
			expect(itemRenders).toBeLessThan(24); // interruption is real
			flushSync(() => set(urgent, 1));
			expect(text(container)).toContain('u:1;');
			expect(text(container)).toContain('n:0;');
			const done = Date.now() + 15000;
			while (!text(container).includes('n:24;') && Date.now() < done) {
				await tick(10);
			}
			expect(text(container)).toContain('n:24;');
			expect(text(container)).toContain('u:1;');
		} finally {
			(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		}
	}, 30000);
});

describe('scenario 17 — lazy initializers under React', () => {
	test('initializer runs at first render read, exactly once', async () => {
		h = makeHarness();
		let runs = 0;
		const a = atom((): number => {
			runs++;
			return 7;
		});
		expect(runs).toBe(0);
		function App() {
			return <span>{useValue(a)}</span>;
		}
		const { container } = await h.mount(<App />);
		expect(text(container)).toBe('7');
		expect(runs).toBe(1);
		await act(async () => {
			set(a, 8);
		});
		expect(text(container)).toBe('8');
		expect(runs).toBe(1);
	});
});

describe('useComputed', () => {
	test('memoized per deps; subscribes; recomputes on dependency writes', async () => {
		h = makeHarness();
		const a = atom(2);
		function App({ k }: { k: number }) {
			const v = useComputed(() => read(a) * k, [k]);
			return <span>{v}</span>;
		}
		const { root, container } = await h.mount(<App k={10} />);
		expect(text(container)).toBe('20');
		await act(async () => {
			set(a, 3);
		});
		expect(text(container)).toBe('30');
		await act(async () => {
			root.render(<App k={100} />);
		});
		expect(text(container)).toBe('300');
	});

	test('computeds resolve the render pass world (draft vs committed)', async () => {
		h = makeHarness();
		const a = atom(1);
		const c = computed(() => read(a) * 10);
		const gate = deferred<void>();
		const hold = atom(false);
		function View() {
			const v = useValue(c);
			const held = useValue(hold);
			if (held && !gate.settled) throw gate.promise;
			return <span>c:{v};</span>;
		}
		const { container } = await h.mount(
			<React.Suspense fallback={null}>
				<View />
			</React.Suspense>,
		);
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 2);
				set(hold, true);
			});
		});
		expect(text(container)).toBe('c:10;'); // committed world on screen
		expect(read(c)).toBe(10);
		gate.settled = true;
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('c:20;');
	});
});
