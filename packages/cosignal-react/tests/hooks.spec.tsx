/**
 * Hook behavior unit tests (task 4a): render/update/unmount, StrictMode,
 * deps-keyed recreation (§3.3), ctx.previous hint (§3.4), useReducerAtom
 * parity scope, useSignalEffect committed-world contract (§5.11).
 */
import { describe, expect, test, afterEach } from 'vitest';
import * as React from 'react';
import { Atom, ReducerAtom } from 'cosignal/logged';
import { useSignal, useComputed, useReducerAtom, useSignalEffect } from '../src/index.js';
import { makeHarness, act, text, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
	await h.cleanup();
});

describe('useSignal', () => {
	test('renders the atom value and re-renders on set', async () => {
		h = makeHarness();
		const a = new Atom(1);
		function View() {
			return <span>{useSignal(a)}</span>;
		}
		const { container } = await h.mount(<View />);
		expect(text(container)).toBe('1');
		await act(async () => {
			a.set(2);
		});
		expect(text(container)).toBe('2');
	});

	test('functional update routes the whole op (replay fidelity)', async () => {
		h = makeHarness();
		const a = new Atom(10);
		function View() {
			return <span>{useSignal(a)}</span>;
		}
		const { container } = await h.mount(<View />);
		await act(async () => {
			a.update((n) => n + 5);
		});
		expect(text(container)).toBe('15');
		// The receipt holds the updater, not a folded value (§5.3 / logged.ts note).
		const node = h.bridge.byKernelId.get(a._id)!;
		const ops = [...node.tape, ...node.archive].map((r) => r.op.kind);
		expect(ops).toContain('update');
	});

	test('unmount unsubscribes (no delivery to dead components)', async () => {
		h = makeHarness();
		const a = new Atom(0);
		let renders = 0;
		function View() {
			renders++;
			return <span>{useSignal(a)}</span>;
		}
		const { root, container } = await h.mount(<View />);
		expect(text(container)).toBe('0');
		await act(async () => {
			root.render(<div />);
		});
		await act(async () => {}); // debounced unsubscribe finalizes
		expect(h.bridge.watchers.size).toBe(0);
		const before = renders;
		await act(async () => {
			a.set(9);
		});
		expect(renders).toBe(before);
	});

	test('two components over one atom stay consistent in one commit', async () => {
		h = makeHarness();
		const a = new Atom('x');
		function View({ id }: { id: string }) {
			return (
				<span>
					{id}={useSignal(a)}{' '}
				</span>
			);
		}
		const { container } = await h.mount(
			<>
				<View id="a" />
				<View id="b" />
			</>,
		);
		await act(async () => {
			a.set('y');
		});
		expect(text(container)).toBe('a=y b=y');
	});

	test('write during render throws (§3.6)', async () => {
		h = makeHarness();
		const a = new Atom(0);
		let thrown: unknown;
		function Bad() {
			try {
				a.set(1);
			} catch (err) {
				thrown = err;
			}
			return <span>{useSignal(a)}</span>;
		}
		await h.mount(<Bad />);
		expect(String(thrown)).toMatch(/write during render/);
	});

	test('StrictMode double render/effects net to one subscription', async () => {
		h = makeHarness();
		const a = new Atom(1);
		function View() {
			return <span>{useSignal(a)}</span>;
		}
		const { container } = await h.mount(
			<React.StrictMode>
				<View />
			</React.StrictMode>,
		);
		expect(text(container)).toBe('1');
		await act(async () => {}); // orphan sweep + unsub debounce settle
		expect(h.bridge.watchers.size).toBe(1);
		await act(async () => {
			a.set(2);
		});
		expect(text(container)).toBe('2');
		expect(h.bridge.watchers.size).toBe(1);
	});
});

describe('useComputed (§3.3 cut C3)', () => {
	test('deps-keyed recreation: equal deps reuse the node, changed deps mint fresh', async () => {
		h = makeHarness();
		const a = new Atom(2);
		const seen: number[] = [];
		function View({ mult }: { mult: number }) {
			const c = useComputed<number>((_ctx) => useSignalValueless(a) * mult, [mult]);
			seen.push(c._node.id);
			return <span>{useSignal(c)}</span>;
		}
		// helper: read the atom inside the computed via its patched .state
		function useSignalValueless(atom: Atom<number>): number {
			return atom.state;
		}
		const { root, container } = await h.mount(<View mult={10} />);
		expect(text(container)).toBe('20');
		await act(async () => {
			root.render(<View mult={10} />);
		});
		expect(new Set(seen).size).toBe(1); // same node reused
		await act(async () => {
			root.render(<View mult={100} />);
		});
		expect(text(container)).toBe('200');
		expect(new Set(seen).size).toBe(2); // fresh node for changed deps
	});

	test('computed re-renders when its atom dependency changes (K1 edges recorded)', async () => {
		h = makeHarness();
		const a = new Atom(1);
		function View() {
			const c = useComputed(() => a.state * 2, []);
			return <span>{useSignal(c)}</span>;
		}
		const { container } = await h.mount(<View />);
		expect(text(container)).toBe('2');
		await act(async () => {
			a.set(5);
		});
		expect(text(container)).toBe('10');
	});

	test('ctx.previous returns the last committed value (§3.4 hint)', async () => {
		h = makeHarness();
		const a = new Atom(1);
		const previousSeen: Array<number | undefined> = [];
		function View() {
			const c = useComputed<number>((ctx) => {
				previousSeen.push(ctx.previous);
				return a.state * 2;
			}, []);
			return <span>{useSignal(c)}</span>;
		}
		const { container } = await h.mount(<View />);
		expect(text(container)).toBe('2');
		expect(previousSeen[0]).toBeUndefined(); // first evaluation: no committed value
		await act(async () => {
			a.set(3);
		});
		expect(text(container)).toBe('6');
		// Some later evaluation observed the previously committed value (2). The
		// contract licenses staleness/undefined but the committed hint must appear.
		expect(previousSeen).toContain(2);
	});
});

describe('useReducerAtom (§3.2)', () => {
	test('dispatch folds through the fixed reducer; ops are replayed whole', async () => {
		h = makeHarness();
		function View() {
			const [count, dispatch] = useReducerAtom((s: number, action: 'inc' | 'dec') => (action === 'inc' ? s + 1 : s - 1), 0);
			return (
				<button onClick={() => dispatch('inc')}>
					<span>{count}</span>
				</button>
			);
		}
		const { container } = await h.mount(<View />);
		expect(text(container)).toBe('0');
		const button = container.querySelector('button')!;
		await act(async () => {
			button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});
		expect(text(container)).toBe('1');
	});

	test('standalone ReducerAtom dispatch classifies with a whole dispatch op', async () => {
		h = makeHarness();
		const r = new ReducerAtom((s: number, a: number) => s + a, 100);
		function View() {
			return <span>{useSignal(r)}</span>;
		}
		const { container } = await h.mount(<View />);
		await act(async () => {
			r.dispatch(7);
		});
		expect(text(container)).toBe('107');
		const node = h.bridge.byKernelId.get(r._id)!;
		const kinds = [...node.tape, ...node.archive].map((x) => x.op.kind);
		expect(kinds).toContain('dispatch');
	});
});

describe('useSignalEffect (§5.11)', () => {
	test('observes committed values and re-fires on committed flips only', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const observed: number[] = [];
		function View() {
			useSignalEffect(() => {
				observed.push(a.state as number);
			}, []);
			return <span>{useSignal(a)}</span>;
		}
		await h.mount(<View />);
		expect(observed).toEqual([0]);
		await act(async () => {
			a.set(1);
		});
		expect(observed[observed.length - 1]).toBe(1);
	});

	test('cleanup runs before re-fire and at unmount', async () => {
		h = makeHarness();
		const a = new Atom(0);
		const log: string[] = [];
		function View() {
			useSignalEffect(() => {
				const v = a.state as number;
				log.push(`run:${v}`);
				return () => log.push(`clean:${v}`);
			}, []);
			return <span>{useSignal(a)}</span>;
		}
		const { root } = await h.mount(<View />);
		await act(async () => {
			a.set(2);
		});
		await act(async () => {
			root.render(<div />);
		});
		expect(log[0]).toBe('run:0');
		expect(log).toContain('clean:0');
		expect(log).toContain('run:2');
		expect(log[log.length - 1]).toBe('clean:2');
	});
});
