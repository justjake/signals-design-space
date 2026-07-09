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
	useCommitted,
	useIsPending,
	useLatest,
	useSignal,
	useSignalEffect,
	useSignalTransition,
	type AltBReactHandle,
} from '../src/react';
import { committed, latest, refresh } from '../src/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let handle: AltBReactHandle;
let roots: Root[];
let containers: HTMLElement[];

beforeEach(() => {
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

describe('fork listener error isolation', () => {
	// Regression pin for the step-0 emit guard (PLAN-edge-export step 0b):
	// protocol events fire synchronously inside commitRoot and the scheduler
	// microtask, so a throwing listener must be captured — never thrown into
	// React — and later listeners must still receive the event.
	it('a throwing listener does not break delivery or the write path', async () => {
		const seen: number[] = [];
		const unsubThrow = handle.fork.subscribeToExternalRuntime({
			onBatchOpened: () => {
				throw new Error('listener boom');
			},
		});
		const unsubRecord = handle.fork.subscribeToExternalRuntime({
			onBatchOpened: (token) => {
				seen.push(token);
			},
		});
		const a = new Atom({ state: 0 });
		function View(): React.ReactNode {
			return <span>{useSignal(a)}</span>;
		}
		const c = await mount(<View />);
		await act(async () => {
			React.startTransition(() => {
				a.set(1);
			});
		});
		expect(c.textContent).toBe('1');
		expect(seen).toHaveLength(1); // the recorder heard the event despite the throw
		expect(handle.fork.listenerErrors).toHaveLength(1);
		expect(String(handle.fork.listenerErrors[0])).toContain('listener boom');
		handle.fork.listenerErrors.length = 0;
		unsubThrow();
		unsubRecord();
	});
});

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
			// Urgent write flips into pending — but the node already settled
			// (-1), so this is REFRESH-pending: the two-level suspense rule
			// serves the stale value through with no fallback flash, and the
			// LOGGED write path must carry the box exactly like DIRECT does.
			await act(async () => {
				flag.set(true);
			});
			expect(el.textContent).toBe('c:-1'); // stale-through, never 'loading'
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

describe('Solid-2.0 async API set against real React (§2/§7, solid2-async-model)', () => {
	/** Resource idiom: one promise per (param, refreshEpoch) request key. */
	function makeResource() {
		const param = new Atom({ state: 1 });
		const gates = new Map<string, { promise: Promise<string>; resolve: (v: string) => void }>();
		function gateFor(key: string) {
			let g = gates.get(key);
			if (g === undefined) {
				let resolve!: (v: string) => void;
				const promise = new Promise<string>((res) => {
					resolve = res;
				});
				g = { promise, resolve };
				gates.set(key, g);
			}
			return g;
		}
		const data = new Computed<string>({
			fn: (ctx) => ctx.use(gateFor(`${param.state}:${ctx.refreshEpoch}`).promise),
		});
		return { param, data, gateFor };
	}

	async function settleKey(r: ReturnType<typeof makeResource>, key: string, v: string) {
		await act(async () => {
			r.gateFor(key).resolve(v);
			await r.gateFor(key).promise;
			await Promise.resolve();
		});
	}

	async function firstLoadVsRefetch(strict: boolean) {
		configure({ strictLanes: strict });
		try {
			const r = makeResource();
			function App() {
				return <span>d:{useSignal(r.data)}</span>;
			}
			const el = await mount(
				<React.Suspense fallback={<i>loading</i>}>
					<App />
				</React.Suspense>,
			);
			// TWO-LEVEL RULE half 1: first load (uninitialized) → fallback.
			expect(el.textContent).toBe('loading');
			await settleKey(r, '1:0', 'one');
			expect(el.textContent).toBe('d:one');
			// TWO-LEVEL RULE half 2: refetch (refresh-pending) → the stale
			// value STAYS; no fallback flash. Settlement writes meet the
			// quiescence gate like any write — identical in both modes.
			await act(async () => {
				refresh(r.data);
			});
			expect(el.textContent).toBe('d:one'); // stale-through, never 'loading'
			await settleKey(r, '1:1', 'two');
			expect(el.textContent).toBe('d:two');
		} finally {
			configure({ strictLanes: false });
		}
	}

	it('first-load → fallback; refetch → stale stays (loose)', async () => {
		await firstLoadVsRefetch(false);
	});

	it('first-load → fallback; refetch → stale stays (strictLanes)', async () => {
		await firstLoadVsRefetch(true);
	});

	async function refreshInTransition(strict: boolean) {
		configure({ strictLanes: strict });
		try {
			const r = makeResource();
			function App() {
				const pending = useIsPending(r.data);
				return (
					<span>
						d:{useSignal(r.data)}
						{pending ? '!' : ''}
					</span>
				);
			}
			const el = await mount(
				<React.Suspense fallback={<i>loading</i>}>
					<App />
				</React.Suspense>,
			);
			await settleKey(r, '1:0', 'one');
			expect(el.textContent).toBe('d:one');
			// Refresh requested inside a transition: rule (a) — the transition
			// pass ALWAYS suspends on the pending box (even refresh-pending),
			// so React HOLDS the transition until settlement. No early commit
			// with stale data; no fallback (suspend-in-transition keeps old
			// UI); the committed screen keeps the old value, with the pending
			// flag arriving through the urgent probe flip.
			await act(async () => {
				React.startTransition(() => {
					r.param.set(2);
					refresh(r.data);
				});
			});
			// Held: the old frame stays, no fallback, no early commit. (The
			// probe flip fired inside the transition scope, so React
			// entangles it with the held lane — the '!' never paints early;
			// an URGENT refresh would paint it, see the flip-only test.)
			expect(el.textContent).toBe('d:one');
			await settleKey(r, '2:1', 'TWO');
			expect(el.textContent).toBe('d:TWO'); // one settlement commit, probe idle
		} finally {
			configure({ strictLanes: false });
		}
	}

	it('refresh-in-transition converges with stale-hold (loose)', async () => {
		await refreshInTransition(false);
	});

	it('refresh-in-transition converges with stale-hold (strictLanes)', async () => {
		await refreshInTransition(true);
	});

	async function useAlignment(strict: boolean) {
		configure({ strictLanes: strict });
		try {
			// Rule (a) alignment: a signals consumer (useSignal → node-held
			// box → React use()) and a DIRECT React.use() consumer of the
			// SAME promise must land in the SAME transition commit — never a
			// frame with one side new and the other old.
			const gate = deferred<string>();
			const flag = new Atom({ state: false });
			const sig = new Computed<string>({
				fn: (ctx) => (flag.state ? ctx.use(gate.promise) : 'off'),
			});
			function SignalSide() {
				return <span>s:{useSignal(sig)}</span>;
			}
			function UseSide({ go }: { go: boolean }) {
				return <b>u:{go ? React.use(gate.promise) : 'off'}</b>;
			}
			const commits: string[] = [];
			let target: HTMLElement | null = null;
			function Recorder() {
				React.useLayoutEffect(() => {
					commits.push(target?.textContent ?? '');
				});
				return null;
			}
			let setGo!: (b: boolean) => void;
			function App() {
				const [go, set] = React.useState(false);
				setGo = set;
				return (
					<React.Suspense fallback={<i>loading</i>}>
						<SignalSide />
						<UseSide go={go} />
						<Recorder />
					</React.Suspense>
				);
			}
			const el = await mount(<App />);
			target = el;
			expect(el.textContent).toBe('s:offu:off');
			await act(async () => {
				React.startTransition(() => {
					flag.set(true); // sig → refresh-pending (latest 'off') on gate.promise
					setGo(true); // UseSide → React.use(gate.promise)
				});
			});
			// Both sides suspended INSIDE the transition: held, no fallback,
			// no early commit — the old frame stays.
			expect(el.textContent).toBe('s:offu:off');
			await act(async () => {
				gate.resolve('DATA');
				await gate.promise;
			});
			expect(el.textContent).toBe('s:DATAu:DATA');
			// The no-tearing assertion: every committed frame is fully-old or
			// fully-new; the two waiters of one promise never split a commit.
			// (The mount commit records '' — the target ref is assigned after
			// mount returns; only real frames are checked.)
			for (const frame of commits.filter((f) => f !== '')) {
				const oldFrame = frame.includes('s:off') && frame.includes('u:off');
				const newFrame = frame.includes('s:DATA') && frame.includes('u:DATA');
				expect(oldFrame || newFrame).toBe(true);
			}
		} finally {
			configure({ strictLanes: false });
		}
	}

	it('signals-side and React-side waiters of one promise commit together (loose)', async () => {
		await useAlignment(false);
	});

	it('signals-side and React-side waiters of one promise commit together (strictLanes)', async () => {
		await useAlignment(true);
	});

	it('useIsPending is flip-only: settled value changes do not re-render the probe consumer', async () => {
		const r = makeResource();
		let probeRenders = 0;
		function Probe() {
			++probeRenders;
			const pending = useIsPending(r.data);
			return <em>{pending ? 'pending' : 'idle'}</em>;
		}
		function Value() {
			return <span>{useSignal(r.data)}</span>;
		}
		const el = await mount(
			<React.Suspense fallback={<i>loading</i>}>
				<Value />
				<Probe />
			</React.Suspense>,
		);
		await settleKey(r, '1:0', 'one');
		expect(el.textContent).toBe('oneidle');
		const before = probeRenders;
		// A refetch settling to a DIFFERENT value: the Value component
		// re-renders for the data; the probe re-renders only for the two
		// pending flips — bounded, not per-value-change.
		await act(async () => {
			refresh(r.data);
		});
		expect(el.textContent).toBe('onepending');
		await settleKey(r, '1:1', 'two');
		expect(el.textContent).toBe('twoidle');
		const flips = probeRenders - before;
		expect(flips).toBeGreaterThanOrEqual(2); // pending→idle→... both flips seen
		// Now a settled→settled change with NO pending phase visible to the
		// probe world: none exists in this model (every refetch pends), so
		// assert the complementary bound instead: renders track flips, not
		// values — 2 flips per cycle.
		await act(async () => {
			refresh(r.data);
		});
		await settleKey(r, '1:2', 'three');
		expect(el.textContent).toBe('threeidle');
		expect(probeRenders - before).toBeLessThanOrEqual(2 * flips + 2);
	});

	it('useLatest never suspends: undefined on first load, stale during refetch (latest asymmetry)', async () => {
		const r = makeResource();
		function App() {
			const v = useLatest(r.data);
			return <span>v:{v ?? 'none'}</span>;
		}
		// NO Suspense boundary needed — useLatest cannot suspend.
		const el = await mount(<App />);
		expect(el.textContent).toBe('v:none'); // uninitialized: no stale value
		await settleKey(r, '1:0', 'one');
		expect(el.textContent).toBe('v:one');
		await act(async () => {
			refresh(r.data);
		});
		expect(el.textContent).toBe('v:one'); // stale through the refetch
		await settleKey(r, '1:1', 'two');
		expect(el.textContent).toBe('v:two');
		// The asymmetric upstream case at top level (outside render): a
		// deferred write is IN-FLIGHT — latest(atom) samples NEWEST.
		let staged = '';
		await act(async () => {
			React.startTransition(() => {
				r.param.set(9);
				staged = `${latest(r.param)}`;
			});
		});
		expect(staged).toBe('9'); // in-flight value visible to latest()
	});
});

describe('ambient-W0 semantics against real React (SPEC-RESOLUTIONS §ambient-W0)', () => {
	async function onClickScenario(strict: boolean) {
		configure({ strictLanes: strict });
		try {
			const a = new Atom({ state: 0 });
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
					throw gate.promise; // holds the transition open
				}
				return <span>v:{v}</span>;
			}
			const c = await mount(
				<React.Suspense fallback={<i>wait</i>}>
					<App />
				</React.Suspense>,
			);
			expect(c.textContent).toBe('v:0');
			// The transition writes a draft and suspends (held).
			await act(async () => {
				React.startTransition(() => {
					a.set(1);
					wantSuspend.set(true);
				});
			});
			expect(c.textContent).toBe('v:0');
			// URGENT onClick derives from an ambient read: .state = W0 = 0 —
			// the pending transition's draft is INVISIBLE (no speculation
			// leak). set(0 * 2) = set(0).
			let sawInHandler = -1;
			await act(async () => {
				sawInHandler = a.state;
				a.set(a.state * 2);
			});
			expect(sawInHandler).toBe(0);
			expect(c.textContent).toBe('v:0');
			// Settle: the transition's set(1) folds BEFORE the urgent set(0)
			// (seq order) — the urgent write supersedes the transition.
			await act(async () => {
				gate.resolve();
				await gate.promise;
			});
			expect(a.state).toBe(0);
			expect(c.textContent).toBe('v:0');
		} finally {
			configure({ strictLanes: false });
		}
	}

	it('onClick: urgent set(state*2) over a pending transition uses W0 and supersedes it (loose)', async () => {
		await onClickScenario(false);
	});

	it('onClick: urgent set(state*2) over a pending transition uses W0 and supersedes it (strictLanes)', async () => {
		await onClickScenario(true);
	});

	async function crossContext(strict: boolean) {
		configure({ strictLanes: strict });
		try {
			const a = new Atom({ state: 0 });
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
					throw gate.promise;
				}
				return <span>v:{v}</span>;
			}
			const c = await mount(
				<React.Suspense fallback={<i>wait</i>}>
					<App />
				</React.Suspense>,
			);
			// WRITE-THEN-READ inside the transition scope: read-your-own-draft.
			let inScope = -1;
			let inScopeLatest: number | undefined;
			await act(async () => {
				React.startTransition(() => {
					a.set(5);
					inScope = a.state; // own draft: 5
					inScopeLatest = latest(a);
					wantSuspend.set(true); // hold the transition open
				});
			});
			expect(inScope).toBe(5);
			expect(inScopeLatest).toBe(5);
			// OUTSIDE the scope, before commit: the draft is invisible to
			// ambient reads; latest()/committed() name the other worlds.
			expect(a.state).toBe(0);
			expect(latest(a)).toBe(5);
			expect(committed(a)).toBe(0);
			expect(c.textContent).toBe('v:0');
			await act(async () => {
				gate.resolve();
				await gate.promise;
			});
			expect(a.state).toBe(5); // committed: now in W0
			expect(c.textContent).toBe('v:5');
		} finally {
			configure({ strictLanes: false });
		}
	}

	it('cross-context write-then-read-before-commit (loose)', async () => {
		await crossContext(false);
	});

	it('cross-context write-then-read-before-commit (strictLanes)', async () => {
		await crossContext(true);
	});

	it('useCommitted tracks the committed world; useLatest the in-flight one', async () => {
		const a = new Atom({ state: 0 });
		const gate = deferred<void>();
		let settled = false;
		void gate.promise.then(() => {
			settled = true;
		});
		const wantSuspend = new Atom({ state: false });
		function App() {
			const v = useSignal(a);
			const suspend = useSignal(wantSuspend);
			const com = useCommitted(a);
			const lat = useLatest(a);
			if (suspend && !settled) {
				throw gate.promise;
			}
			return (
				<span>
					v:{v};c:{com};l:{lat}
				</span>
			);
		}
		const c = await mount(
			<React.Suspense fallback={<i>wait</i>}>
				<App />
			</React.Suspense>,
		);
		expect(c.textContent).toBe('v:0;c:0;l:0');
		await act(async () => {
			React.startTransition(() => {
				a.set(4);
				wantSuspend.set(true);
			});
		});
		// Held: the committed frame shows committed values everywhere (the
		// useLatest render read follows the committed pass world — replay
		// purity; the Wn observable is top-level latest()).
		expect(c.textContent).toBe('v:0;c:0;l:0');
		expect(latest(a)).toBe(4);
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(c.textContent).toBe('v:4;c:4;l:4');
	});

	it('useAtom lazy initializer (§lazy-init): evaluated at first render read, once per atom instance', async () => {
		let runs = 0;
		let setOwned!: (n: number) => void;
		function App() {
			const a = useAtom<number>({
				state: () => {
					++runs;
					return 7;
				},
			});
			setOwned = (n: number) => a.set(n);
			return <span>n:{useSignal(a)}</span>;
		}
		const c = await mount(<App />);
		expect(c.textContent).toBe('n:7');
		expect(runs).toBe(1); // once per materialized atom instance
		await act(async () => {
			setOwned(8);
		});
		expect(c.textContent).toBe('n:8');
		expect(runs).toBe(1);
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
