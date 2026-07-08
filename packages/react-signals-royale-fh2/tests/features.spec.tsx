// @vitest-environment jsdom
/**
 * The real-React gate, part 2: Suspense/async (scenario 11), lifetime
 * effects (14), causality trace (15), DOM mutation window (16), SSR (18),
 * plus useCommitted / useSignalEffect / useAtom.
 */
import { describe, expect, test, afterEach } from 'vitest';
import * as React from 'react';
import {
	atom,
	computed,
	effect,
	read,
	refresh,
	serializeAtomState,
	initializeAtomState,
	set,
	type Atom,
	type Computed,
} from 'signals-royale-fh2';
import {
	onDomMutation,
	startTransitionWrite,
	traceView,
	useCommitted,
	useIsPending,
	useSignalEffect,
	useValue,
} from '../src/index';
import { makeHarness, act, text, deferred, tick, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
	await h.cleanup();
});

describe('scenario 11 — Suspense family', () => {
	function makeResource(param: Atom<number>) {
		let epoch = 0;
		let fetchCount = 0;
		const gates = new Map<string, ReturnType<typeof deferred<string>>>();
		const data = computed((use) => {
			const key = `${read(param)}:${epoch}`;
			let g = gates.get(key);
			if (g === undefined) {
				g = deferred<string>();
				gates.set(key, g);
				fetchCount++;
			}
			return use(g.promise);
		});
		return {
			data,
			fetchCount: () => fetchCount,
			refresh() {
				epoch++;
				refresh(data);
			},
			async settle(key: string, v: string) {
				const g = gates.get(key);
				if (g === undefined) {
					throw new Error(`no request for ${key}; have ${[...gates.keys()].join(',')}`);
				}
				await act(async () => {
					g.resolve(v);
					await g.promise;
					await Promise.resolve();
				});
			},
		};
	}

	function DataView({ data }: { data: Computed<string> }) {
		return <span>d:{useValue(data)}</span>;
	}

	test('first load: fallback, converge, one fetch across retries', async () => {
		h = makeHarness();
		const param = atom(0);
		const r = makeResource(param);
		const { container } = await h.mount(
			<React.Suspense fallback={<i>loading</i>}>
				<DataView data={r.data} />
			</React.Suspense>,
		);
		expect(text(container)).toBe('loading');
		await r.settle('0:0', 'one');
		expect(text(container)).toBe('d:one');
		expect(r.fetchCount()).toBe(1); // thenable identity stable across retries
	});

	test('refresh: stale serves, isPending flips, no fallback flash', async () => {
		h = makeHarness();
		const param = atom(0);
		const r = makeResource(param);
		function Probe() {
			return <em>{useIsPending(r.data) ? 'P' : 'i'};</em>;
		}
		const { container } = await h.mount(
			<>
				<Probe />
				<React.Suspense fallback={<i>loading</i>}>
					<DataView data={r.data} />
				</React.Suspense>
			</>,
		);
		await r.settle('0:0', 'one');
		expect(text(container)).toBe('i;d:one');
		await act(async () => {
			r.refresh();
		});
		expect(text(container)).toBe('P;d:one'); // stale + pending, no fallback
		expect(r.fetchCount()).toBe(2);
		await r.settle('0:1', 'two');
		expect(text(container)).toBe('i;d:two');
	});

	test('settlement inside a transition commits with the transition', async () => {
		h = makeHarness();
		const param = atom(0);
		const r = makeResource(param);
		const { container } = await h.mount(
			<React.Suspense fallback={<i>loading</i>}>
				<DataView data={r.data} />
			</React.Suspense>,
		);
		await r.settle('0:0', 'one');
		await act(async () => {
			startTransitionWrite(() => {
				set(param, 1);
				r.refresh();
			});
		});
		expect(text(container)).toBe('d:one'); // held: no fallback, no early commit
		await r.settle('1:1', 'TWO');
		expect(text(container)).toBe('d:TWO');
		expect(r.fetchCount()).toBe(2); // the retired world's fetch carried over
	});

	test('a rejected fetch rethrows one stable box at the read site (error boundary catches)', async () => {
		h = makeHarness();
		const d = deferred<string>();
		const data = computed((use) => use(d.promise));
		const seen: unknown[] = [];
		class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
			state = { failed: false };
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(e: unknown) {
				seen.push(e);
			}
			render() {
				return this.state.failed ? <i>failed</i> : this.props.children;
			}
		}
		const { container } = await h.mount(
			<Boundary>
				<React.Suspense fallback={<i>loading</i>}>
					<DataView data={data} />
				</React.Suspense>
			</Boundary>,
		);
		expect(text(container)).toBe('loading');
		await act(async () => {
			d.reject(new Error('boom'));
			await Promise.resolve();
		});
		expect(text(container)).toBe('failed');
		expect(seen.length).toBeGreaterThan(0);
	});
});

describe('scenario 14 — lifetime effects', () => {
	test('first render subscriber mounts the observation; last unmount cleans up; ctx writes flow', async () => {
		h = makeHarness();
		const log: string[] = [];
		const a = atom(0, {
			effect: (ctx) => {
				log.push(`observe:${ctx.get()}`);
				ctx.set(42);
				return () => log.push('unobserve');
			},
		});
		function Reader({ id }: { id: string }) {
			return (
				<span>
					{id}:{useValue(a)};
				</span>
			);
		}
		function App({ showA, showB }: { showA: boolean; showB: boolean }) {
			return (
				<>
					{showA ? <Reader id="A" /> : null}
					{showB ? <Reader id="B" /> : null}
				</>
			);
		}
		const { root, container } = await h.mount(<App showA={true} showB={true} />);
		await act(async () => {});
		expect(log).toEqual(['observe:0']); // union of subscribers: one observation
		expect(text(container)).toBe('A:42;B:42;');
		await act(async () => {
			root.render(<App showA={false} showB={true} />);
		});
		await act(async () => {});
		expect(log).toEqual(['observe:0']);
		await act(async () => {
			root.render(<App showA={false} showB={false} />);
		});
		await act(async () => {});
		expect(log).toEqual(['observe:0', 'unobserve']);
	});

	test('engine effects count toward the union; same-tick flaps coalesce', async () => {
		h = makeHarness();
		const log: string[] = [];
		const a = atom(0, {
			effect: () => {
				log.push('observe');
				return () => log.push('unobserve');
			},
		});
		const d1 = effect(() => {
			void read(a);
		});
		await tick();
		expect(log).toEqual(['observe']);
		d1();
		const d2 = effect(() => {
			void read(a);
		});
		await tick();
		expect(log).toEqual(['observe']); // flap netted out
		d2();
		await tick();
		expect(log).toEqual(['observe', 'unobserve']);
	});
});

describe('scenario 15 — causality trace', () => {
	test('after scenario 3: urgent chain reaches the write; post-retirement chain reaches the retirement', async () => {
		h = makeHarness();
		const t = traceView();
		const a = atom(1);
		const hold = atom(false);
		const gate = deferred<void>();
		function App() {
			const v = useValue(a);
			const held = useValue(hold);
			if (held && !gate.settled) throw gate.promise;
			return <span>v:{v}</span>;
		}
		const { container } = await h.mount(
			<React.Suspense fallback={<i>fb</i>}>
				<App />
			</React.Suspense>,
		);
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 2);
				set(hold, true);
			});
		});
		await act(async () => {
			set(a, 3); // urgent mid-transition
		});
		expect(text(container)).toBe('v:3');
		const urgentChain = t.whyLastDelivery(a);
		expect(urgentChain.length).toBeGreaterThan(0);
		expect(urgentChain.join(' ')).toMatch(/write/i);
		gate.settled = true;
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		const retiredChain = t.whyLastDelivery(a);
		expect(retiredChain.join(' ')).toMatch(/retire|write/i);
		// Structural soundness: every causal parent is an earlier, real event.
		const events = t.events();
		const ids = new Set(events.map((e) => e.id));
		for (const e of events) {
			if (e.cause !== undefined) {
				expect(e.cause).toBeLessThan(e.id);
				expect(ids.has(e.cause)).toBe(true);
			}
		}
		t.stop();
	});

	test('ring mode bounds memory and counts overflow', async () => {
		h = makeHarness();
		const t = traceView({ ring: 8 });
		const a = atom(0);
		function View() {
			return <span>{useValue(a)}</span>;
		}
		await h.mount(<View />);
		for (let i = 1; i <= 30; i++) {
			await act(async () => {
				set(a, i);
			});
		}
		expect(t.events().length).toBeLessThanOrEqual(8);
		expect(t.dropped()).toBeGreaterThan(0);
		t.stop();
	});
});

describe('scenario 16 — DOM mutation window', () => {
	test('a MutationObserver blinded during the window sees zero React mutations, all third-party ones', async () => {
		h = makeHarness();
		const a = atom(0);
		function Reader() {
			return <span>r:{useValue(a)};</span>;
		}
		const { container } = await h.mount(<Reader />);
		const leaked: MutationRecord[] = [];
		const mo = new MutationObserver((records) => leaked.push(...records));
		const observe = () => mo.observe(container, { childList: true, characterData: true, subtree: true });
		observe();
		const phases: string[] = [];
		const off = onDomMutation((phase, c) => {
			phases.push(`${phase}:${c === container ? 'here' : 'other'}`);
			if (phase === 'start') {
				leaked.push(...mo.takeRecords());
				mo.disconnect();
			} else {
				observe();
			}
		});
		await act(async () => {
			set(a, 1);
		});
		leaked.push(...mo.takeRecords());
		expect(text(container)).toBe('r:1;');
		expect(leaked).toEqual([]); // React mutated only inside the window
		const here = phases.filter((p) => p.endsWith(':here'));
		expect(here.length).toBeGreaterThanOrEqual(2);
		expect(here.length % 2).toBe(0);
		for (let i = 0; i < here.length; i += 2) {
			expect(here[i]).toBe('start:here');
			expect(here[i + 1]).toBe('stop:here');
		}
		container.appendChild(document.createElement('div'));
		expect(mo.takeRecords().length).toBeGreaterThan(0); // third-party still seen
		mo.disconnect();
		off();
	});
});

describe('scenario 18 — SSR', () => {
	test('serialize -> install on a fresh engine -> first client render matches, zero corrective re-renders', async () => {
		h = makeHarness();
		const s1 = atom(1);
		const s2 = atom('x');
		set(s1, 5);
		const json = serializeAtomState([s1 as Atom<unknown>, s2 as Atom<unknown>]);
		// Fresh engine ("client").
		await h.cleanup();
		h = makeHarness();
		let initRuns = 0;
		const c1 = atom((): number => {
			initRuns++;
			return 0;
		});
		const c2 = atom('default');
		initializeAtomState(json, [c1 as Atom<unknown>, c2 as Atom<unknown>]);
		expect(initRuns).toBe(0); // install is not a read: initializer untouched
		let renders = 0;
		function App() {
			renders++;
			return (
				<span>
					{useValue(c1)}:{useValue(c2)}
				</span>
			);
		}
		const { container } = await h.mount(<App />);
		expect(text(container)).toBe('5:x');
		expect(renders).toBe(1);
		expect(initRuns).toBe(0);
	});
});

describe('useCommitted and useSignalEffect', () => {
	test('useCommitted tracks what is on this root screen, not drafts', async () => {
		h = makeHarness();
		const a = atom(0);
		const gate = deferred<void>();
		const hold = atom(false);
		function Suspender() {
			const v = useValue(a);
			const held = useValue(hold);
			if (held && !gate.settled) throw gate.promise;
			return <span>s:{v};</span>;
		}
		function Committed() {
			return <b>c:{useCommitted(a)};</b>;
		}
		const { container } = await h.mount(
			<>
				<Committed />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		expect(text(container)).toBe('c:0;s:0;');
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 4);
				set(hold, true);
			});
		});
		expect(text(container)).toBe('c:0;s:0;'); // draft invisible to committed
		gate.settled = true;
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		await act(async () => {});
		expect(text(container)).toBe('c:4;s:4;');
	});

	test('useSignalEffect re-runs on canonical changes with cleanup; never sees drafts', async () => {
		h = makeHarness();
		const a = atom(0);
		const runs: number[] = [];
		const cleans: number[] = [];
		function App() {
			useSignalEffect(() => {
				const v = read(a);
				runs.push(v);
				return () => cleans.push(v);
			});
			return null;
		}
		const { root } = await h.mount(<App />);
		expect(runs).toEqual([0]);
		await act(async () => {
			startTransitionWrite(() => set(a, 1));
		});
		await act(async () => {});
		expect(runs[runs.length - 1]).toBe(1); // observed at retirement, not before
		await act(async () => {
			set(a, 2);
		});
		expect(runs[runs.length - 1]).toBe(2);
		expect(cleans).toContain(1);
		await act(async () => {
			root.render(null);
		});
		expect(cleans).toContain(2); // unmount cleanup
	});
});
