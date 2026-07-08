// @vitest-environment jsdom
/**
 * Real-React gate, scenarios 1-10: batching, transitions, tearing, mount
 * mid-transition, flushSync, multi-root, StrictMode, unmount, write-during-
 * render.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { flushSync } from 'react-dom';
import {
	atom,
	batch,
	set,
	startTransitionWrite,
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

describe('1. commits coalesce', () => {
	test('a batch of writes commits once', async () => {
		const a = atom(0, { label: 'a' });
		const b = atom(0, { label: 'b' });
		let renders = 0;
		function View() {
			renders++;
			return (
				<span>
					{useValue(a)}:{useValue(b)}
				</span>
			);
		}
		const { container } = await harness.mount(<View />);
		renders = 0;
		await act(async () => {
			batch(() => {
				set(a, 1);
				set(b, 2);
			});
		});
		expect(container.textContent).toBe('1:2');
		expect(renders).toBe(1);
	});
});

describe('2. transition pending state', () => {
	test('draft never appears in committed DOM; useIsPending true meanwhile', async () => {
		const a = atom('base', { label: 'a' });
		const observedDom: string[] = [];
		function View() {
			return <span>{useValue(a)}</span>;
		}
		function Pending() {
			return <i>{useIsPending(a) ? 'pending' : 'idle'}</i>;
		}
		const { container } = await harness.mount(
			<div>
				<View />
				<Pending />
			</div>,
		);
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 'next');
			});
			observedDom.push(container.querySelector('span')!.textContent!);
			await tick();
			observedDom.push(container.querySelector('span')!.textContent!);
		});
		// The draft never hit the DOM before the transition committed.
		expect(observedDom[0]).toBe('base');
		expect(container.querySelector('span')!.textContent).toBe('next');
		expect(container.querySelector('i')!.textContent).toBe('idle');
	});

	test('useIsPending flips true while the transition is held open', async () => {
		const gate = atom(false, { label: 'gate' });
		const a = atom(0, { label: 'a' });
		const pendingStates: boolean[] = [];
		function Pending() {
			const pending = useIsPending(a);
			pendingStates.push(pending);
			return <i>{pending ? 'pending' : 'idle'}</i>;
		}
		// A component that suspends while the gate atom is true keeps the
		// transition from committing.
		const never = new Promise(() => {});
		function MaybeSuspend() {
			const blocked = useValue(gate);
			const value = useValue(a);
			if (blocked && value > 0) throw never;
			return <b>{value}</b>;
		}
		const { container } = await harness.mount(
			<div>
				<MaybeSuspend />
				<Pending />
			</div>,
		);
		await act(async () => {
			set(gate, true);
		});
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 5);
			});
			await tick();
		});
		// Transition parked on the suspense; drafts stay off screen and the
		// probe reports pending.
		expect(container.querySelector('b')!.textContent).toBe('0');
		expect(container.querySelector('i')!.textContent).toBe('pending');
	});
});

describe('3. urgent during live transition', () => {
	test('urgent commits alone; transition rebases on top', async () => {
		const a = atom(1, { label: 'a' });
		const committedValues: string[] = [];
		function View() {
			return <span>{useValue(a)}</span>;
		}
		const { container } = await harness.mount(<View />);
		await act(async () => {
			startTransitionWrite(() => {
				update(a, (x) => x * 2);
			});
			// The urgent write commits alone, immediately (flushSync makes the
			// immediacy observable in the test).
			flushSync(() => {
				update(a, (x) => x + 1);
			});
			committedValues.push(container.textContent!);
		});
		committedValues.push(container.textContent!);
		expect(committedValues).toEqual(['2', '4']);
	});
});

describe('4. sibling readers never tear', () => {
	test('many siblings agree within every commit, across transitions', async () => {
		const a = atom(0, { label: 'a' });
		const seen: number[][] = [];
		function Sib({ i }: { i: number }) {
			const v = useValue(a);
			return <span data-i={i}>{v}</span>;
		}
		const N = 8;
		function All() {
			return (
				<div>
					{Array.from({ length: N }, (_, i) => (
						<Sib key={i} i={i} />
					))}
				</div>
			);
		}
		const { container } = await harness.mount(<All />);
		const snap = () =>
			seen.push(
				Array.from(container.querySelectorAll('span')).map((s) => Number(s.textContent)),
			);
		await act(async () => {
			startTransitionWrite(() => set(a, 10));
			set(a, 5);
			flushSync(() => {});
			snap();
			await tick();
			snap();
		});
		snap();
		for (const commit of seen) {
			expect(new Set(commit).size).toBe(1);
		}
		expect(container.querySelector('span')!.textContent).toBe('10');
	});
});

describe('5. mount mid-transition', () => {
	test('new subscriber shows committed value, then joins the transition commit', async () => {
		const a = atom('old', { label: 'a' });
		const show = atom(false, { label: 'show' });
		function Reader({ tag }: { tag: string }) {
			return <span data-tag={tag}>{useValue(a)}</span>;
		}
		function App() {
			const mounted = useValue(show);
			return (
				<div>
					<Reader tag="first" />
					{mounted ? <Reader tag="second" /> : null}
				</div>
			);
		}
		const { container } = await harness.mount(<App />);
		const texts = () =>
			Array.from(container.querySelectorAll('span')).map((s) => s.textContent);
		let duringMount: (string | null)[] = [];
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 'new');
			});
			// Urgent mount while the transition is pending.
			flushSync(() => {
				set(show, true);
			});
			duringMount = texts();
			await tick();
		});
		// At the urgent mount the new subscriber showed the committed value.
		expect(duringMount).toEqual(['old', 'old']);
		// After the transition landed, both show the new value (no tear).
		expect(texts()).toEqual(['new', 'new']);
	});
});

describe('6. flushSync excludes pending deferred work', () => {
	test('flushSync flushes urgent only', async () => {
		const a = atom(0, { label: 'a' });
		function View() {
			return <span>{useValue(a)}</span>;
		}
		const { container } = await harness.mount(<View />);
		await act(async () => {
			startTransitionWrite(() => set(a, 100));
			flushSync(() => {
				set(a, 1);
			});
			expect(container.textContent).toBe('1');
			await tick();
		});
		expect(container.textContent).toBe('100');
	});
});

describe('7. one transition batch spanning two roots', () => {
	test('per-root consistency; both roots land the transition', async () => {
		const a = atom(0, { label: 'a' });
		function View({ tag }: { tag: string }) {
			return <span data-tag={tag}>{useValue(a)}</span>;
		}
		const { container: c1 } = await harness.mount(<View tag="r1" />);
		const { container: c2 } = await harness.mount(<View tag="r2" />);
		await act(async () => {
			startTransitionWrite(() => {
				set(a, 7);
			});
			expect(c1.textContent).toBe('0');
			expect(c2.textContent).toBe('0');
			await tick();
		});
		expect(c1.textContent).toBe('7');
		expect(c2.textContent).toBe('7');
	});
});

describe('8. StrictMode', () => {
	test('double-mount nets one engine subscription and one lifetime observation', async () => {
		let opens = 0;
		let closes = 0;
		const a = atom(1, {
			label: 'a',
			onObserved: () => {
				opens++;
				return () => closes++;
			},
		});
		function View() {
			return <span>{useValue(a)}</span>;
		}
		await harness.mount(
			<React.StrictMode>
				<View />
			</React.StrictMode>,
		);
		await act(async () => {
			await tick();
		});
		expect(a.subs.size).toBe(1);
		expect(opens).toBe(1);
		expect(closes).toBe(0);
		await harness.cleanup();
		harness = makeHarness();
		await act(async () => {
			await tick();
		});
		expect(a.subs.size).toBe(0);
		expect(opens).toBe(1);
		expect(closes).toBe(1);
	});
});

describe('9. unmount', () => {
	test('no further deliveries; subscriptions return to baseline', async () => {
		const a = atom(0, { label: 'a' });
		let renders = 0;
		function View() {
			renders++;
			return <span>{useValue(a)}</span>;
		}
		const { root } = await harness.mount(<View />);
		await act(async () => {
			root.unmount();
		});
		expect(a.subs.size).toBe(0);
		renders = 0;
		await act(async () => {
			set(a, 5);
		});
		expect(renders).toBe(0);
	});
});

describe('10. write-during-render fails loudly', () => {
	test('a render-phase write throws', async () => {
		const a = atom(0, { label: 'a' });
		function Bad() {
			set(a, 1);
			return null;
		}
		await expect(
			act(async () => {
				const { root } = harness.newRoot();
				root.render(<Bad />);
			}),
		).rejects.toThrow(/during render/);
	});
});
