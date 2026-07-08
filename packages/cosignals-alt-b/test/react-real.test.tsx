// @vitest-environment jsdom
// Phase 3 — the bindings against the REAL patched React (react-dom/client +
// act): transition lockstep, interruption + rebase, mount-during-transition,
// suspense + retry, the flushSync gate-contract family in BOTH modes, multi-
// root, StrictMode, effects ordering.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
	Atom,
	__debug,
	__resetEngineForTests,
	configure,
	Computed,
} from '../src/index';
import {
	registerAltBReact,
	useAtom,
	useComputed,
	useSignal,
	useSignalEffect,
	useSignalTransition,
	type AltBReactHandle,
} from '../src/react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ReactWithReset = typeof React & { unstable_resetBatchRegistryForTest(): void };

let handle: AltBReactHandle;
let roots: Root[];
let containers: HTMLElement[];

beforeEach(() => {
	(React as ReactWithReset).unstable_resetBatchRegistryForTest();
	__resetEngineForTests();
	handle = registerAltBReact();
	roots = [];
	containers = [];
});

afterEach(async () => {
	await act(async () => {
		for (const r of roots) {
			r.unmount();
		}
	});
	handle.dispose();
	(React as ReactWithReset).unstable_resetBatchRegistryForTest();
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	containers.push(container);
	await act(async () => {
		root.render(node);
	});
	return container;
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('transitions against real React', () => {
	it('signal + React state move in lockstep inside one transition (§4.5)', async () => {
		const a = new Atom({ state: 0 });
		let setLabel!: (s: string) => void;
		function App() {
			const v = useSignal(a);
			const [label, set] = React.useState('old');
			setLabel = set;
			return <span>{label}:{v}</span>;
		}
		const c = await mount(<App />);
		expect(c.textContent).toBe('old:0');
		await act(async () => {
			React.startTransition(() => {
				a.set(1);
				setLabel('new');
			});
		});
		// One commit carries both: never "new:0" or "old:1".
		expect(c.textContent).toBe('new:1');
	});

	it('a held-open transition leaves committed state on screen; urgent writes rebase (§10.7)', async () => {
		const a = new Atom({ state: 1 });
		const gate = deferred<void>();
		let settled = false;
		void gate.promise.then(() => {
			settled = true;
		});
		const wantSuspend = new Atom({ state: false });
		function App() {
			const v = useSignal(a);
			const suspend = useSignal(wantSuspend);
			if (suspend && !settled) {
				throw gate.promise; // holds the transition's render open
			}
			return <span>v:{v}</span>;
		}
		const c = await mount(
			<React.Suspense fallback={<i>wait</i>}>
				<App />
			</React.Suspense>,
		);
		expect(c.textContent).toBe('v:1');
		// The transition: +1 AND flip the suspender on — its render suspends,
		// so it cannot commit until the gate settles.
		await act(async () => {
			React.startTransition(() => {
				a.update((x) => x + 1);
				wantSuspend.set(true);
			});
		});
		expect(c.textContent).toBe('v:1'); // still the committed world
		// Urgent interruption while the transition is pending: *2.
		await act(async () => {
			a.update((x) => x * 2);
		});
		expect(c.textContent).toBe('v:2'); // urgent world: 1*2, transition invisible
		expect(__debug.kernelValue(a)).toBe(2);
		// Settle: the transition commits ON TOP of the urgent change (rebase):
		// (1 + 1) * 2 = 4 — exactly React's own updater-queue arithmetic.
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(c.textContent).toBe('v:4');
		expect(a.state).toBe(4);
	});

	it('a component mounting during a transition reads the pending world in the same commit (§13.2)', async () => {
		const a = new Atom({ state: 0 });
		const show = new Atom({ state: false });
		function Late() {
			const v = useSignal(a);
			return <b>late:{v}</b>;
		}
		function App() {
			const s = useSignal(show);
			const v = useSignal(a);
			return (
				<span>
					main:{v};{s ? <Late /> : null}
				</span>
			);
		}
		const c = await mount(<App />);
		expect(c.textContent).toBe('main:0;');
		await act(async () => {
			React.startTransition(() => {
				a.set(7);
				show.set(true);
			});
		});
		// The commit that mounts Late must show the transition's 7 in BOTH
		// components — the frame stock-React userland provably tears on.
		expect(c.textContent).toBe('main:7;late:7');
	});

	it('useSignalTransition batches writes and reports isPending', async () => {
		const a = new Atom({ state: 0 });
		const b2 = new Atom({ state: 0 });
		let start!: (scope: () => void) => void;
		const pendingSeen: boolean[] = [];
		function App() {
			const [isPending, startScoped] = useSignalTransition();
			start = startScoped;
			pendingSeen.push(isPending);
			return (
				<span>
					{useSignal(a)}:{useSignal(b2)}
				</span>
			);
		}
		const c = await mount(<App />);
		await act(async () => {
			start(() => {
				a.set(1);
				b2.set(2);
			});
		});
		expect(c.textContent).toBe('1:2');
		expect(pendingSeen).toContain(true); // the pending phase rendered
	});
});

describe('suspense through ctx.use (§12.3)', () => {
	it('a suspended computed suspends the component and converges on settle', async () => {
		const gate = deferred<number>();
		const c = new Computed<number>({ fn: (ctx) => ctx.use(gate.promise) * 2 });
		function App() {
			return <span>c:{useSignal(c)}</span>;
		}
		const el = await mount(
			<React.Suspense fallback={<i>loading</i>}>
				<App />
			</React.Suspense>,
		);
		expect(el.textContent).toBe('loading');
		await act(async () => {
			gate.resolve(21);
			await gate.promise;
		});
		// Retry re-renders through the NODE-HELD pending box (identity stable
		// across retries) and converges — no refetch loop.
		expect(el.textContent).toBe('c:42');
	});

	it('two interleaved suspending works on one root keep distinct node-held data (no aliasing)', async () => {
		// The lineage-keyed positional cache this replaced shared one
		// synthesized lineage between interleaved works on a root, so their
		// per-attempt thenable slots could alias. With node-held boxes the
		// identity is the NODE: two works can never observe each other's
		// thenables or data.
		const gateA = deferred<string>();
		const gateB = deferred<string>();
		const flagA = new Atom({ state: false });
		const flagB = new Atom({ state: false });
		const cA = new Computed<string>({
			fn: (ctx) => (flagA.state ? ctx.use(gateA.promise) : 'a0'),
		});
		const cB = new Computed<string>({
			fn: (ctx) => (flagB.state ? ctx.use(gateB.promise) : 'b0'),
		});
		function A() {
			return <span>{useSignal(cA)}</span>;
		}
		function B() {
			return <em>{useSignal(cB)}</em>;
		}
		const el = await mount(
			<React.Suspense fallback={<i>loading</i>}>
				<A />
				<B />
			</React.Suspense>,
		);
		expect(el.textContent).toBe('a0b0');
		// Work 1: A's world starts suspending (held open — no fallback).
		await act(async () => {
			React.startTransition(() => flagA.set(true));
		});
		expect(el.textContent).toBe('a0b0');
		// Work 2 interleaves on the SAME root while work 1 is still pending.
		await act(async () => {
			React.startTransition(() => flagB.set(true));
		});
		expect(el.textContent).toBe('a0b0');
		// Settle B first. Whether or not React entangles the two lanes, no
		// frame may ever show one work's data in the other's slot.
		await act(async () => {
			gateB.resolve('B2');
			await gateB.promise;
		});
		expect(el.textContent === 'a0B2' || el.textContent === 'a0b0').toBe(true);
		expect(el.textContent).not.toContain('A1');
		await act(async () => {
			gateA.resolve('A1');
			await gateA.promise;
		});
		expect(el.textContent).toBe('A1B2'); // both works landed with their own data
	});

	it('suspense converges identically under strictLanes (gate mode is orthogonal to pending)', async () => {
		configure({ strictLanes: true });
		try {
			const gate = deferred<number>();
			const flag = new Atom({ state: false });
			const c = new Computed<number>({
				fn: (ctx) => (flag.state ? ctx.use(gate.promise) * 2 : -1),
			});
			function App() {
				return <span>c:{useSignal(c)}</span>;
			}
			const el = await mount(
				<React.Suspense fallback={<i>loading</i>}>
					<App />
				</React.Suspense>,
			);
			expect(el.textContent).toBe('c:-1');
			expect(__debug.isDirect()).toBe(false); // pinned LOGGED
			// Urgent write flips into pending: no transition holds it open, so
			// the boundary shows its fallback — pending is value-state, and the
			// LOGGED write path must carry the box exactly like DIRECT does.
			// (React HIDES re-suspended content rather than unmounting it, so
			// textContent still carries the hidden 'c:-1'.)
			await act(async () => {
				flag.set(true);
			});
			expect(el.textContent).toContain('loading');
			// Settlement is a normal (logged) write: invalidate → propagate.
			await act(async () => {
				gate.resolve(21);
				await gate.promise;
			});
			expect(el.textContent).toBe('c:42');
		} finally {
			configure({ strictLanes: false });
		}
	});
});

describe('the write-gate contract family against real React timing (§9.1/§17.6)', () => {
	// NOTE (measured, not assumed): in THIS patched React build, a queued
	// default-lane useState update IS included in a same-task flushSync
	// render (verified by a useState-only control: setM(5); flushSync(setN)
	// renders "5:1"). The spec's distinguishing schedule (§9.1: flushSync
	// excluding the default lane) therefore does not manifest here — so the
	// contract family asserts the observable that matters on this build:
	// SIDE-BY-SIDE PARITY with useState through the identical schedule, in
	// both gate modes, plus the loose default's visibility guarantee.
	function makeApp() {
		const a = new Atom({ state: 0 });
		let setM!: (n: number) => void;
		let setN!: (n: number) => void;
		function App() {
			const v = useSignal(a);
			const [m, sm] = React.useState(0);
			const [n, sn] = React.useState(0);
			setM = sm;
			setN = sn;
			return (
				<span>
					s{v}:m{m}:n{n}
				</span>
			);
		}
		return { a, App, setM: (x: number) => setM(x), setN: (x: number) => setN(x) };
	}

	it('LOOSE default: idle write visible to the flushSync render; useState parity holds on this build', async () => {
		const { a, App, setM, setN } = makeApp();
		const c = await mount(<App />);
		expect(__debug.isDirect()).toBe(true); // fully quiescent → DIRECT
		let inside = '';
		await act(async () => {
			a.set(5); // idle-time write: commits immediately, no receipt (§9.1)
			setM(5); // the useState control through the same schedule
			flushSync(() => {
				setN(1);
			});
			inside = c.textContent ?? '';
		});
		// The loose contract's guarantee: the idle write is visible to every
		// subsequent render — and on this build useState behaves identically,
		// so the frame shows both fives (no observable deviation here).
		expect(inside).toBe('s5:m5:n1');
		expect(c.textContent).toBe('s5:m5:n1'); // converged, nothing lost
	});

	it('strictLanes: exact useState parity through the identical schedule', async () => {
		configure({ strictLanes: true });
		const { a, App, setM, setN } = makeApp();
		const c = await mount(<App />);
		expect(__debug.isDirect()).toBe(false); // pinned LOGGED
		let inside = '';
		await act(async () => {
			a.set(5); // logged under the default-lane batch the fork mints
			setM(5);
			flushSync(() => {
				setN(1);
			});
			inside = c.textContent ?? '';
		});
		// Parity: the signal shows 5 in the flushSync frame IFF useState's m
		// does. On this build both are included (measured control) — the
		// signal must never diverge from m.
		const [, sPart, mPart] = /s(\d+):m(\d+):n/.exec(inside)!;
		expect(sPart).toBe(mPart);
		expect(c.textContent).toBe('s5:m5:n1');
		expect(a.state).toBe(5);
		configure({ strictLanes: false });
	});
});

describe('multi-root, StrictMode, effects', () => {
	it('two roots over one atom never tear against each other', async () => {
		const a = new Atom({ state: 0 });
		function App() {
			return <span>{useSignal(a)}</span>;
		}
		const c1 = await mount(<App />);
		const c2 = await mount(<App />);
		await act(async () => {
			React.startTransition(() => {
				a.set(3);
			});
		});
		expect(c1.textContent).toBe('3');
		expect(c2.textContent).toBe('3');
	});

	it('StrictMode double-mount nets to one live subscription; writes still propagate', async () => {
		const a = new Atom({ state: 0 });
		const observedLog: string[] = [];
		const observed = new Atom<number>({
			state: 0,
			effect: () => {
				observedLog.push('mount');
				return () => observedLog.push('cleanup');
			},
		});
		function App() {
			return (
				<span>
					{useSignal(a)}:{useSignal(observed)}
				</span>
			);
		}
		const c = await mount(
			<React.StrictMode>
				<App />
			</React.StrictMode>,
		);
		await act(async () => {
			a.set(1);
		});
		expect(c.textContent).toBe('1:0');
		await act(async () => {
			a.set(2);
		});
		expect(c.textContent).toBe('2:0'); // watcher survived the double-mount
		await act(async () => {}); // drain the observe microtask
		// Observed-lifecycle nets to a single mount (§12.4 debounce).
		expect(observedLog).toEqual(['mount']);
	});

	it('useAtom holds component state; useComputed derives with signal tracking', async () => {
		const external = new Atom({ state: 10 });
		let bumpLocal!: () => void;
		function App() {
			const local = useAtom({ state: 1 });
			bumpLocal = () => local.update((x) => x + 1);
			const sum = useComputed(() => local.state + external.state, []);
			return <span>{sum}</span>;
		}
		const c = await mount(
			<React.StrictMode>
				<App />
			</React.StrictMode>,
		);
		expect(c.textContent).toBe('11');
		await act(async () => {
			bumpLocal();
		});
		expect(c.textContent).toBe('12');
		await act(async () => {
			external.set(20);
		});
		expect(c.textContent).toBe('22');
	});

	it('useSignalEffect observes committed values, after commit, with cleanup ordering', async () => {
		const a = new Atom({ state: 0 });
		const log: string[] = [];
		function App() {
			const v = useSignal(a);
			useSignalEffect(() => {
				const seen = a.state; // committed view
				log.push(`run:${seen}`);
				return () => log.push(`cleanup:${seen}`);
			});
			return <span>{v}</span>;
		}
		await mount(<App />);
		await act(async () => {}); // effect flush
		expect(log).toEqual(['run:0']);
		await act(async () => {
			a.set(1);
		});
		await act(async () => {}); // per-root committed flush (microtask)
		expect(log).toEqual(['run:0', 'cleanup:0', 'run:1']);
	});
});
