// @vitest-environment jsdom
/**
 * The real-React gate: RULES scenarios 1-18 against THIS fork build, driven
 * through the package's own hook surface.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { flushSync } from 'react-dom';
import {
	atom,
	computed,
	effect,
	batch,
	read,
	latest,
	committed,
	isPending,
	refresh,
	serializeAtomState,
	initializeAtomState,
	startTrace,
	lastDeliveryEvent,
	__resetEngine,
	type Atom,
} from 'signals-royale-fh1';
import {
	useValue,
	useIsPending,
	useCommitted,
	useComputed,
	useSignalEffect,
	useAtom,
	startTransitionWrite,
	onDomMutation,
} from '../src/index';
import { React, act, setup, teardown, mount, newRoot, text, deferred, tick } from './helpers';

beforeEach(setup);
afterEach(teardown);

function Reader({ id, a }: { id: string; a: Atom<number> }) {
	return (
		<span>
			{id}:{useValue(a)};
		</span>
	);
}

describe('1 — one commit per urgent write / per batch', () => {
	test('single write, batch of writes', async () => {
		const a = atom(0);
		const b = atom(0);
		let renders = 0;
		function App() {
			renders++;
			return (
				<span>
					{useValue(a)},{useValue(b)}
				</span>
			);
		}
		const { container } = await mount(<App />);
		expect(text(container)).toBe('0,0');
		const before = renders;
		await act(async () => a.set(1));
		expect(renders).toBe(before + 1);
		await act(async () =>
			batch(() => {
				a.set(2);
				b.set(3);
			}),
		);
		expect(text(container)).toBe('2,3');
		expect(renders).toBe(before + 2);
	});
});

describe('2 — transition invisible until commit; isPending meanwhile', () => {
	test('held transition; read family agrees', async () => {
		const a = atom(0);
		const hold = atom(false);
		const gate = deferred<void>();
		function Suspender() {
			const v = useValue(a);
			if (useValue(hold) && !gate.settled) throw gate.promise;
			return <span>v:{v};</span>;
		}
		function Probe() {
			return <em>{useIsPending(a) ? 'P' : 'i'};</em>;
		}
		const { container } = await mount(
			<>
				<Probe />
				<React.Suspense fallback={<i>fb;</i>}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		await act(async () => {
			startTransitionWrite(() => {
				a.set(1);
				hold.set(true);
			});
		});
		expect(text(container)).toBe('P;v:0;'); // no draft leak, no fallback, pending flip urgent
		expect(read(a)).toBe(0);
		expect(committed(a)).toBe(0);
		expect(latest(a)).toBe(1);
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('i;v:1;');
		expect(read(a)).toBe(1);
	});
});

describe('2b — latest() in a component body resolves the render pass world', () => {
	// Judgement-round regression: a direct latest() call in a render body must
	// agree with useValue in the same pass — an urgent re-render beside a held
	// transition must not serve the live draft (that is a tear).
	test('urgent re-render while a draft batch is live: body latest() agrees with useValue', async () => {
		const a = atom(1);
		const nudge = atom(0);
		const hold = atom(false);
		const gate = deferred<void>();
		const pairs: Array<[number, number]> = [];
		function App() {
			const v = useValue(a);
			const n = useValue(nudge);
			pairs.push([v, latest(a)]);
			return (
				<span>
					v:{v};n:{n};
				</span>
			);
		}
		function Suspender() {
			if (useValue(hold) && !gate.settled) throw gate.promise;
			return <i>ok;</i>;
		}
		const { container } = await mount(
			<>
				<App />
				<React.Suspense fallback={<i>fb;</i>}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		await act(async () => {
			startTransitionWrite(() => {
				a.set(2);
				hold.set(true);
			});
		});
		await act(async () => nudge.set(1)); // urgent re-render; the draft batch is still live
		expect(text(container)).toContain('v:1;n:1;'); // canonical on screen
		for (const [v, l] of pairs) expect(l).toBe(v); // no pass ever tears
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toContain('v:2;');
	});
});

describe('3 + 13 — urgent commits alone; retirement replays the whole log', () => {
	test('(1+1)*2 = 4 and the 1 → 2 → 6 branch discipline', async () => {
		const a = atom(1);
		const hold = atom(false);
		const gate = deferred<void>();
		const seen: number[] = [];
		function Value() {
			const v = useValue(a);
			React.useLayoutEffect(() => {
				seen.push(v);
			});
			return <span>v:{v};</span>;
		}
		function Holder() {
			if (useValue(hold) && !gate.settled) throw gate.promise;
			return null;
		}
		const { container } = await mount(
			<>
				<Value />
				<React.Suspense fallback={null}>
					<Holder />
				</React.Suspense>
			</>,
		);
		await act(async () => {
			startTransitionWrite(() => {
				a.update((x) => x + 2);
				hold.set(true);
			});
		});
		expect(text(container)).toBe('v:1;');
		await act(async () => a.update((x) => x * 2));
		expect(text(container)).toBe('v:2;');
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('v:6;'); // (1+2)*2 — replay, never reorder
		const collapsed = seen.filter((v, i) => i === 0 || v !== seen[i - 1]);
		expect(collapsed).toEqual([1, 2, 6]);
	});
});

describe('4 — sibling readers never tear', () => {
	test('pairs agree across interleaved urgent + transition', async () => {
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
		const { container } = await mount(
			<>
				<Pair />
				<Pair />
			</>,
		);
		await act(async () => {
			a.set(1);
			startTransitionWrite(() => a.set(2));
		});
		await act(async () => {});
		expect(text(container)).toBe('2,2;2,2;');
		for (const [v1, v2] of pairs) expect(v1).toBe(v2);
	});
});

describe('5 — mount mid-transition', () => {
	test('late subscriber shows committed, then joins the transition commit', async () => {
		const a = atom(0);
		function App({ extra }: { extra: boolean }) {
			return (
				<>
					<Reader id="r1" a={a} />
					{extra ? <Reader id="r2" a={a} /> : null}
				</>
			);
		}
		const gate = deferred<void>();
		const hold = atom(false);
		function Holder() {
			if (useValue(hold) && !gate.settled) throw gate.promise;
			return null;
		}
		const { root, container } = await mount(
			<>
				<App extra={false} />
				<React.Suspense fallback={null}>
					<Holder />
				</React.Suspense>
			</>,
		);
		await act(async () => {
			startTransitionWrite(() => {
				a.set(1);
				hold.set(true);
			});
		});
		expect(text(container)).toBe('r1:0;');
		await act(async () => {
			root.render(
				<>
					<App extra={true} />
					<React.Suspense fallback={null}>
						<Holder />
					</React.Suspense>
				</>,
			);
		});
		expect(text(container)).toBe('r1:0;r2:0;'); // committed world, never the draft
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('r1:1;r2:1;'); // one consistent world
	});
});

describe('6 — flushSync excludes pending deferred work', () => {
	test('sync commit never carries the parked batch', async () => {
		const a = atom(0);
		const b = atom(0);
		const gate = deferred<void>();
		function Suspender() {
			const v = useValue(a);
			if (v > 0 && !gate.settled) throw gate.promise;
			return <span>s:{v};</span>;
		}
		const { container } = await mount(
			<>
				<Reader id="a" a={a} />
				<Reader id="b" a={b} />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		await act(async () => {
			startTransitionWrite(() => a.set(9));
		});
		await act(async () => {
			flushSync(() => b.set(1));
			expect(text(container)).toBe('a:0;b:1;s:0;');
		});
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('a:9;b:1;s:9;');
	});
});

describe('7 — one transition batch over two roots', () => {
	test('per-root consistency and committed views', async () => {
		const a = atom(0);
		const gate = deferred<void>();
		function Suspender() {
			const v = useValue(a);
			if (v > 0 && !gate.settled) throw gate.promise;
			return <span>s:{v};</span>;
		}
		const one = await mount(
			<React.Suspense fallback={null}>
				<Suspender />
			</React.Suspense>,
		);
		const two = await mount(<Reader id="r" a={a} />);
		await act(async () => {
			startTransitionWrite(() => a.set(1));
		});
		expect(text(one.container)).toBe('s:0;'); // held here
		expect(text(two.container)).toBe('r:1;'); // committed here
		expect(committed(a, one.container)).toBe(0);
		expect(committed(a, two.container)).toBe(1);
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(one.container)).toBe('s:1;');
		expect(committed(a, one.container)).toBe(1);
	});
});

describe('8 + 9 — StrictMode nets one; unmount silences', () => {
	test('double-mount: one subscription, one observation; unmount cleans up', async () => {
		const log: string[] = [];
		const a = atom(0, {
			effect: () => {
				log.push('observe');
				return () => log.push('unobserve');
			},
		});
		let renders = 0;
		function App() {
			renders++;
			return <span>{useValue(a)}</span>;
		}
		const { root, container } = await mount(
			<React.StrictMode>
				<App />
			</React.StrictMode>,
		);
		await act(async () => {});
		expect(log).toEqual(['observe']);
		await act(async () => a.set(2));
		expect(text(container)).toBe('2'); // the surviving subscription delivered
		await act(async () => root.render(null));
		await act(async () => {});
		expect(log).toEqual(['observe', 'unobserve']);
		const before = renders;
		await act(async () => {
			a.set(3);
			startTransitionWrite(() => a.set(4));
		});
		await act(async () => {});
		expect(renders).toBe(before); // unmounted subscribers receive nothing
	});
});

describe('10 — write-during-render fails loudly', () => {
	test('set from a component body throws synchronously', async () => {
		const a = atom(0);
		let thrown: unknown;
		function Bad() {
			const v = useValue(a);
			if (v === 0) {
				try {
					a.set(1);
				} catch (e) {
					thrown = e;
				}
			}
			return <span>{v}</span>;
		}
		const { container } = await mount(<Bad />);
		expect(String(thrown)).toMatch(/render/);
		expect(text(container)).toBe('0');
	});
});

describe('11 — suspense family', () => {
	function resource() {
		let epoch = 0;
		let fetches = 0;
		const gates = new Map<string, ReturnType<typeof deferred<string>>>();
		const param = atom(0);
		const data = computed((use) => {
			const key = `${param.get()}:${epoch}`;
			let g = gates.get(key);
			if (g === undefined) {
				g = deferred<string>();
				gates.set(key, g);
				fetches++;
			}
			return use(g.promise);
		});
		return {
			param,
			data,
			fetches: () => fetches,
			refreshIt() {
				epoch++;
				refresh(data);
			},
			async settle(key: string, v: string) {
				await act(async () => {
					gates.get(key)!.resolve(v);
					await gates.get(key)!.promise;
					await Promise.resolve();
				});
			},
		};
	}

	test('first load: fallback then converge; one fetch across retries', async () => {
		const r = resource();
		function View() {
			return <span>d:{useValue(r.data)}</span>;
		}
		const { container } = await mount(
			<React.Suspense fallback={<i>loading</i>}>
				<View />
			</React.Suspense>,
		);
		expect(text(container)).toBe('loading');
		await r.settle('0:0', 'one');
		expect(text(container)).toBe('d:one');
		expect(r.fetches()).toBe(1);
	});

	test('refresh: stale serves, isPending flips, no fallback flash', async () => {
		const r = resource();
		function View() {
			return <span>d:{useValue(r.data)}</span>;
		}
		function Probe() {
			return <em>{useIsPending(r.data) ? 'P' : 'i'};</em>;
		}
		const { container } = await mount(
			<>
				<Probe />
				<React.Suspense fallback={<i>loading</i>}>
					<View />
				</React.Suspense>
			</>,
		);
		await r.settle('0:0', 'one');
		expect(text(container)).toBe('i;d:one');
		await act(async () => r.refreshIt());
		expect(text(container)).toBe('P;d:one');
		expect(r.fetches()).toBe(2);
		await r.settle('0:1', 'two');
		expect(text(container)).toBe('i;d:two');
	});

	test('settlement inside a transition commits with the transition', async () => {
		const r = resource();
		function View() {
			return <span>d:{useValue(r.data)}</span>;
		}
		const { container } = await mount(
			<React.Suspense fallback={<i>loading</i>}>
				<View />
			</React.Suspense>,
		);
		await r.settle('0:0', 'one');
		await act(async () => {
			startTransitionWrite(() => {
				r.param.set(1);
				r.refreshIt();
			});
		});
		expect(text(container)).toBe('d:one'); // held: stale stays on screen
		await r.settle('1:1', 'TWO');
		expect(text(container)).toBe('d:TWO');
	});
});

describe('12 — time slicing', () => {
	test('urgent flushSync lands while the transition renders', async () => {
		const items = atom(0);
		const urgent = atom(0);
		let itemRenders = 0;
		function SlowItem({ k }: { k: number }) {
			itemRenders++;
			const end = performance.now() + 4;
			while (performance.now() < end) {
				/* burn one slice */
			}
			return <i>{k},</i>;
		}
		function List() {
			const n = useValue(items);
			const kids = [] as React.ReactNode[];
			for (let k = 0; k < n; k++) kids.push(<SlowItem key={k} k={k} />);
			return (
				<div>
					n:{n};{kids}
				</div>
			);
		}
		function Input() {
			return <b>u:{useValue(urgent)};</b>;
		}
		const { container } = await mount(
			<>
				<Input />
				<List />
			</>,
		);
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
		try {
			startTransitionWrite(() => items.set(24));
			const deadline = Date.now() + 5000;
			while (itemRenders < 3 && Date.now() < deadline) await tick(5);
			expect(itemRenders).toBeGreaterThanOrEqual(3);
			expect(itemRenders).toBeLessThan(24);
			flushSync(() => urgent.set(1));
			expect(text(container)).toContain('u:1;');
			expect(text(container)).toContain('n:0;');
			const done = Date.now() + 15000;
			while (!text(container).includes('n:24;') && Date.now() < done) await tick(10);
			expect(text(container)).toContain('n:24;');
		} finally {
			(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		}
	});
});

describe('14 — lifetime effects', () => {
	test('React + engine subscribers share one observation; flaps coalesce', async () => {
		const log: string[] = [];
		const a = atom(0, {
			effect: (ctx) => {
				log.push(`observe:${ctx.get()}`);
				ctx.set(42);
				return () => log.push('unobserve');
			},
		});
		const { root, container } = await mount(<Reader id="A" a={a} />);
		await act(async () => {});
		expect(log).toEqual(['observe:0']);
		expect(text(container)).toBe('A:42;');
		// an engine effect keeps the union alive after the component unmounts
		const dispose = effect(() => void read(a));
		await act(async () => root.render(null));
		await act(async () => {});
		expect(log).toEqual(['observe:0']);
		dispose();
		await tick();
		expect(log).toEqual(['observe:0', 'unobserve']);
	});
});

describe('15 — causality trace', () => {
	test('deliveries chain to writes and retirements', async () => {
		const t = startTrace();
		const a = atom(1);
		const hold = atom(false);
		const gate = deferred<void>();
		function App() {
			const v = useValue(a);
			if (useValue(hold) && !gate.settled) throw gate.promise;
			return <span>v:{v}</span>;
		}
		const { container } = await mount(
			<React.Suspense fallback={null}>
				<App />
			</React.Suspense>,
		);
		await act(async () => {
			startTransitionWrite(() => {
				a.update((x) => x + 1);
				hold.set(true);
			});
		});
		await act(async () => a.update((x) => x * 2));
		expect(text(container)).toBe('v:2');
		expect(t.explain(lastDeliveryEvent(a)).join(' ')).toMatch(/write/i);
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(text(container)).toBe('v:4');
		expect(t.explain(lastDeliveryEvent(a)).join(' ')).toMatch(/retire|write/i);
		// structure: every cause is an earlier, present event
		const ids = new Set(t.events().map((e) => e.id));
		for (const e of t.events()) {
			if (e.cause !== 0) {
				expect(e.cause).toBeLessThan(e.id);
				expect(ids.has(e.cause)).toBe(true);
			}
		}
		t.stop();
	});
});

describe('16 — DOM mutation window', () => {
	test('a blinded MutationObserver sees zero React mutations', async () => {
		const a = atom(0);
		const { container } = await mount(<Reader id="r" a={a} />);
		const leaked: MutationRecord[] = [];
		const mo = new MutationObserver((records) => leaked.push(...records));
		const observe = () =>
			mo.observe(container, { childList: true, characterData: true, subtree: true });
		observe();
		const phases: string[] = [];
		const off = onDomMutation((phase, c) => {
			if (c !== container) return;
			phases.push(phase);
			if (phase === 'start') {
				leaked.push(...mo.takeRecords());
				mo.disconnect();
			} else {
				observe();
			}
		});
		await act(async () => a.set(1));
		leaked.push(...mo.takeRecords());
		expect(text(container)).toBe('r:1;');
		expect(leaked).toEqual([]);
		expect(phases.length).toBeGreaterThanOrEqual(2);
		expect(phases[0]).toBe('start');
		container.appendChild(document.createElement('div'));
		expect(mo.takeRecords().length).toBeGreaterThan(0);
		mo.disconnect();
		off();
	});
});

describe('17 — lazy initializers', () => {
	test('first render read runs it once; set-before-read runs it first', async () => {
		let runs = 0;
		const a = atom(() => {
			runs++;
			return 7;
		});
		expect(runs).toBe(0);
		function App() {
			return <span>{useValue(a)}</span>;
		}
		const { container } = await mount(<App />);
		expect(text(container)).toBe('7');
		expect(runs).toBe(1);

		let runs2 = 0;
		const b = atom(() => {
			runs2++;
			return 1;
		});
		b.set(5);
		expect(runs2).toBe(1);
		expect(read(b)).toBe(5);
	});
});

describe('18 — SSR', () => {
	test('serialize, install on a fresh engine, zero corrective re-renders', async () => {
		const s1 = atom(1);
		const s2 = atom('x');
		s1.set(5);
		const json = serializeAtomState({ s1, s2 });
		__resetEngine();
		setup();
		let initRuns = 0;
		const c1 = atom((): number => {
			initRuns++;
			return 0;
		});
		const c2 = atom('default');
		initializeAtomState(json, { s1: c1, s2: c2 });
		expect(initRuns).toBe(0);
		let renders = 0;
		function App() {
			renders++;
			return (
				<span>
					{useValue(c1)}:{useValue(c2)}
				</span>
			);
		}
		const { container } = await mount(<App />);
		expect(text(container)).toBe('5:x');
		expect(renders).toBe(1);
		expect(initRuns).toBe(0);
	});
});

describe('extra hook surface', () => {
	test('useComputed, useSignalEffect, useAtom, useCommitted', async () => {
		const a = atom(2);
		const effectSeen: number[] = [];
		function App() {
			const local = useAtom(10);
			const doubled = useComputed(() => useValueless(a) * 2, [a]);
			useSignalEffect(() => {
				effectSeen.push(read(a));
			});
			const com = useCommitted(a);
			return (
				<span>
					{useValue(local)}|{doubled}|{com}
				</span>
			);
		}
		// useComputed's fn runs inside the engine computed, not the render, so
		// it reads through the engine directly:
		function useValueless(x: Atom<number>): number {
			return read(x);
		}
		const { container } = await mount(<App />);
		expect(text(container)).toBe('10|4|2');
		await act(async () => a.set(3));
		expect(text(container)).toBe('10|6|3');
		expect(effectSeen).toEqual([2, 3]);
	});
});
