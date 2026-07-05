/**
 * The react-concurrent-store 14-scenario harness, adapted to cosignal-react
 * (task 4b). SOURCE NOTE: vendor/react/packages contains NO
 * react-concurrent-store package at this checkout (56178d8c13), so the 14
 * scenarios are DERIVED from the spec's battery cases (§6) + the S4 handoff,
 * numbered R1-R14. R6 is the mid-transition-suspense case — the package's
 * KNOWN BUG that this design fixes (spec case 15 row 2) — and must PASS.
 */
import { describe, expect, test, afterEach } from 'vitest';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { Atom } from 'cosignal/logged';
import { useSignal, useComputed, startSignalTransition } from '../src/index.js';
import { makeHarness, act, text, deferred, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
	await h.cleanup();
});

function Reader({ id, atom }: { id: string; atom: Atom<number> }) {
	return (
		<span>
			{id}:{useSignal(atom)};
		</span>
	);
}

describe('react-concurrent-store scenarios (derived; R1-R14)', () => {
	test('R1: subscribe, read, update from an event handler (urgent)', async () => {
		h = makeHarness();
		const a = new Atom(0);
		function App() {
			return (
				<button onClick={() => a.set(a.state + 1)}>
					<Reader id="r" atom={a} />
				</button>
			);
		}
		const { container } = await h.mount(<App />);
		expect(text(container)).toBe('r:0;');
		await act(async () => {
			container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});
		expect(text(container)).toBe('r:1;');
	});

	test('R2: multiple writes in one handler land in one committed render', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const b = new Atom(0);
		let renders = 0;
		function Both() {
			renders++;
			return (
				<span>
					{useSignal(a)},{useSignal(b)}
				</span>
			);
		}
		const { container } = await h.mount(<Both />);
		const before = renders;
		await act(async () => {
			a.set(1);
			b.set(2);
		});
		expect(text(container)).toBe('1,2');
		expect(renders).toBe(before + 1); // one commit for the grouped event writes
	});

	test('R3: a pending transition write never leaks into the committed DOM', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const gate = deferred<void>();
		function Suspender() {
			const v = useSignal(a);
			if (v > 0 && gate.settled !== true) throw gate.promise;
			return <span>s:{v};</span>;
		}
		const { container } = await h.mount(
			<>
				<Reader id="r" atom={a} />
				<React.Suspense fallback={<span>fb;</span>}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		expect(text(container)).toBe('r:0;s:0;');
		await act(async () => {
			React.startTransition(() => a.set(1));
		});
		// Transition suspended: committed DOM unchanged, no fallback (transition
		// semantics), and the newest world holds 1 while committed shows 0.
		expect(text(container)).toBe('r:0;s:0;');
		gate.settled = true;
		await act(async () => {
			gate.resolve();
		});
		expect(text(container)).toBe('r:1;s:1;');
	});

	test('R4: urgent write during a pending transition commits alone (no leak either way)', async () => {
		h = makeHarness();
		const a = new Atom(0); // transition-written
		const b = new Atom(0); // urgent-written
		const gate = deferred<void>();
		function Suspender() {
			const v = useSignal(a);
			if (v > 0 && gate.settled !== true) throw gate.promise;
			return <span>s:{v};</span>;
		}
		const { container } = await h.mount(
			<>
				<Reader id="a" atom={a} />
				<Reader id="b" atom={b} />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		await act(async () => {
			React.startTransition(() => a.set(5));
		});
		expect(text(container)).toBe('a:0;b:0;s:0;');
		await act(async () => {
			b.set(1); // urgent, mid-transition
		});
		expect(text(container)).toBe('a:0;b:1;s:0;'); // b commits, a stays excluded
		gate.settled = true;
		await act(async () => {
			gate.resolve();
		});
		expect(text(container)).toBe('a:5;b:1;s:5;');
	});

	test('R5: sibling readers never tear within one commit', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const observedPairs: Array<[number, number]> = [];
		function Pair() {
			const v1 = useSignal(a);
			const v2 = useSignal(a);
			observedPairs.push([v1, v2]);
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
			a.set(1);
			React.startTransition(() => a.set(2));
		});
		await act(async () => {});
		expect(text(container)).toBe('2,2;2,2;');
		for (const [v1, v2] of observedPairs) expect(v1).toBe(v2); // no intra-render tear
	});

	test('R6: mount mid-transition with suspending pending state (the KNOWN BUG — must pass)', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const gate = deferred<void>();
		function Suspender() {
			const v = useSignal(a);
			if (v > 0 && gate.settled !== true) throw gate.promise;
			return <span>s:{v};</span>;
		}
		function App({ extra }: { extra: boolean }) {
			return (
				<>
					<Reader id="r1" atom={a} />
					<React.Suspense fallback={<span>fb;</span>}>
						<Suspender />
					</React.Suspense>
					{extra ? <Reader id="r2" atom={a} /> : null}
				</>
			);
		}
		const { root, container } = await h.mount(<App extra={false} />);
		expect(text(container)).toBe('r1:0;s:0;');

		// The transition writes the store and suspends mid-render.
		await act(async () => {
			React.startTransition(() => a.set(1));
		});
		expect(text(container)).toBe('r1:0;s:0;'); // pending, no fallback, no leak

		// A NEW component mounts mid-transition (urgent). react-concurrent-store's
		// known bug: the fresh mount reads the mutated store (1) and tears against
		// its committed siblings. Here the mount reads the COMMITTED world (0).
		await act(async () => {
			root.render(<App extra />);
		});
		expect(text(container)).toBe('r1:0;s:0;r2:0;');
		expect(text(container)).not.toContain(':1'); // the design's raison d'être

		// The mount fixup entangled r2 with the live transition batch (§5.10):
		// a value-blind corrective was scheduled in the batch's own lane.
		expect(h.bridge.eventsOfType('mount-corrective').length).toBeGreaterThan(0);

		// Settle the suspension: the transition retries and commits atomically.
		gate.settled = true;
		await act(async () => {
			gate.resolve();
		});
		expect(text(container)).toBe('r1:1;s:1;r2:1;'); // one consistent world
	});

	test('R7: writes during render are rejected', async () => {
		h = makeHarness();
		const a = new Atom(0);
		let thrown: unknown;
		function Bad() {
			const v = useSignal(a);
			if (v === 0) {
				try {
					a.set(1);
				} catch (err) {
					thrown = err;
				}
			}
			return <span>{v}</span>;
		}
		const { container } = await h.mount(<Bad />);
		expect(String(thrown)).toMatch(/during render/);
		expect(text(container)).toBe('0');
	});

	test('R8: unmounted subscribers receive nothing', async () => {
		h = makeHarness();
		const a = new Atom(0);
		let renders = 0;
		function View() {
			renders++;
			return <span>{useSignal(a)}</span>;
		}
		const { root } = await h.mount(<View />);
		await act(async () => {
			root.render(<div />);
		});
		await act(async () => {});
		const before = renders;
		await act(async () => {
			a.set(1);
			React.startTransition(() => a.set(2));
		});
		await act(async () => {});
		expect(renders).toBe(before);
		expect(h.bridge.watchers.size).toBe(0);
	});

	test('R9: StrictMode double render + double effects stay correct', async () => {
		h = makeHarness();
		const a = new Atom(0);
		function App() {
			const doubled = useComputed<number>(() => a.state * 2, []);
			return (
				<span>
					{useSignal(a)}/{useSignal(doubled)}
				</span>
			);
		}
		const { container } = await h.mount(
			<React.StrictMode>
				<App />
			</React.StrictMode>,
		);
		expect(text(container)).toBe('0/0');
		await act(async () => {}); // let debounced netting settle
		expect(h.bridge.watchers.size).toBe(2); // one per useSignal, net of doubles
		await act(async () => {
			a.set(3);
		});
		expect(text(container)).toBe('3/6');
		await act(async () => {
			React.startTransition(() => a.set(4));
		});
		await act(async () => {});
		expect(text(container)).toBe('4/8');
	});

	test('R10: two roots over one store both update; per-root commits reported', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const one = await h.mount(<Reader id="one" atom={a} />);
		const two = await h.mount(<Reader id="two" atom={a} />);
		await act(async () => {
			a.set(7);
		});
		expect(text(one.container)).toBe('one:7;');
		expect(text(two.container)).toBe('two:7;');
		const roots = new Set(h.bridge.eventsOfType('per-root-commit').map((e) => e.root));
		expect(roots.size).toBeGreaterThanOrEqual(2);
	});

	test('R11: late subscriber joins the pending transition batch (one commit, no tear)', async () => {
		h = makeHarness();
		const a = new Atom(0);
		function App({ extra }: { extra: boolean }) {
			return (
				<>
					<Reader id="r1" atom={a} />
					{extra ? <Reader id="r2" atom={a} /> : null}
				</>
			);
		}
		const { root, container } = await h.mount(<App extra={false} />);
		await act(async () => {
			React.startTransition(() => a.set(1)); // scheduled, not yet rendered
			flushSync(() => root.render(<App extra />)); // urgent mount FIRST
			// Mid-state: the urgent commit rendered the committed world.
			expect(text(container)).toBe('r1:0;r2:0;');
		});
		await act(async () => {});
		// The transition's own render folded r2's corrective: one final world.
		expect(text(container)).toBe('r1:1;r2:1;');
		expect(h.bridge.eventsOfType('mount-corrective').length).toBeGreaterThan(0);
	});

	test('R12: async action parity — parked prefix, ambient post-await raw write, scope write at settle', async () => {
		h = makeHarness();
		const a = new Atom(0); // sync-prefix write (parks with the action)
		const b = new Atom(0); // raw post-await write (ambient — commits early)
		const c = new Atom(0); // scope write (parks with the action)
		const io = deferred<void>();
		const settled = deferred<void>();
		const { container } = await h.mount(
			<>
				<Reader id="a" atom={a} />
				<Reader id="b" atom={b} />
				<Reader id="c" atom={c} />
			</>,
		);
		await act(async () => {
			startSignalTransition(async (scope) => {
				a.set(1); // transition context: the action's token
				await io.promise;
				b.set(2); // bare continuation: ambient default (React parity)
				scope.set(c, 3); // explicit: the action's token
				settled.resolve();
			});
		});
		expect(text(container)).toBe('a:0;b:0;c:0;'); // parked: nothing committed
		await act(async () => {
			io.resolve();
			await settled.promise;
		});
		await act(async () => {});
		expect(text(container)).toBe('a:1;b:2;c:3;');
		// The raw post-await write was dev-warned as outside the action (§3.5).
		expect(h.handle.shim.devWarnings.some((m) => m.includes('outside the action'))).toBe(true);
	});

	test('R13: flushSync commits urgently and excludes the pending deferred batch', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const b = new Atom(0);
		const gate = deferred<void>();
		function Suspender() {
			const v = useSignal(a);
			if (v > 0 && gate.settled !== true) throw gate.promise;
			return <span>s:{v};</span>;
		}
		const { container } = await h.mount(
			<>
				<Reader id="a" atom={a} />
				<Reader id="b" atom={b} />
				<React.Suspense fallback={null}>
					<Suspender />
				</React.Suspense>
			</>,
		);
		await act(async () => {
			React.startTransition(() => a.set(9)); // pending deferred batch
		});
		await act(async () => {
			flushSync(() => b.set(1)); // synchronous urgent commit
			expect(text(container)).toBe('a:0;b:1;s:0;'); // a's batch excluded
		});
		gate.settled = true;
		await act(async () => {
			gate.resolve();
		});
		expect(text(container)).toBe('a:9;b:1;s:9;');
	});

	test('R14: selectors stay value-correct under value-blind delivery (§5.9 pin)', async () => {
		h = makeHarness();
		const user = new Atom({ name: 'ada', age: 36 });
		const rendered: string[] = [];
		function Name() {
			const name = useComputed<string>(() => (user.state as { name: string }).name, []);
			const v = useSignal(name);
			rendered.push(v);
			return <span>{v}</span>;
		}
		const { container } = await h.mount(<Name />);
		await act(async () => {
			user.set({ name: 'ada', age: 37 }); // same selected value
		});
		// Delivery is value-blind by design (§5.9 — equality cutoffs on delivery
		// are pinned dead); the re-render is priced, never wrong: the selected
		// value and the DOM stay stable.
		expect(text(container)).toBe('ada');
		expect(rendered.every((v) => v === 'ada')).toBe(true);
		await act(async () => {
			user.set({ name: 'grace', age: 37 });
		});
		expect(text(container)).toBe('grace');
	});
});
