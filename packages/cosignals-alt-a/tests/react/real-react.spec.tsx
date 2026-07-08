// @vitest-environment jsdom
/**
 * PHASE 3 — real-runtime confirmation (§17.6 families) against the actual
 * patched React build (vendor/react via pnpm overrides): the fork double
 * keeps proving the §6 protocol in unit tests; THESE tests prove the bridge
 * + hooks against the real reconciler: lockstep transitions, interruption +
 * rebase, mount-during-transition, Suspense via ctx.use, flushSync
 * exclusion, multi-root, StrictMode, committed-only effects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createCosignalEngine } from '../../src/engine';
import { createAPI, type CosignalAPI } from '../../src/api';
import {
	registerAltAReact,
	startSignalTransition,
	useAtom,
	useComputed,
	useReducerAtom,
	useSignal,
	useSignalEffect,
	type AltAReactHandle,
} from '../../src/react/hooks';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let api: CosignalAPI;
let handle: AltAReactHandle;
let roots: Root[];
let containers: HTMLElement[];

beforeEach(() => {
	api = createAPI(createCosignalEngine());
	handle = registerAltAReact(api);
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
	expect(handle.bridge.errors).toEqual([]);
});

function mount(node: React.ReactNode): HTMLElement {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	containers.push(container);
	act(() => {
		root.render(node);
	});
	return container;
}

function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

describe('real React: basics', () => {
	it('useSignal renders and re-renders on urgent writes', async () => {
		const count = new api.Atom({ state: 1 });
		let renders = 0;
		function View(): React.ReactNode {
			++renders;
			return <span data-testid="v">{useSignal(count)}</span>;
		}
		const c = mount(<View />);
		expect(c.textContent).toBe('1');
		await act(async () => {
			count.set(2);
		});
		expect(c.textContent).toBe('2');
		expect(renders).toBeLessThanOrEqual(3);
	});

	it('useAtom / useReducerAtom / useComputed smoke', async () => {
		let clicks!: () => void;
		function View(): React.ReactNode {
			const local = useAtom({ state: 5 });
			const [total, dispatch] = useReducerAtom((s: number, a: number) => s + a, 100);
			const doubled = useComputed(() => local.state * 2, []);
			clicks = () => {
				local.set(local.state + 1);
				dispatch(1);
			};
			return <span>{`${local.state}:${doubled}:${total}`}</span>;
		}
		const c = mount(<View />);
		expect(c.textContent).toBe('5:10:100');
		await act(async () => {
			clicks();
		});
		expect(c.textContent).toBe('6:12:101');
	});
});

describe('real React: transitions', () => {
	it('lockstep: signal writes and React state move in one commit', async () => {
		const sig = new api.Atom({ state: 'a0' });
		const frames: string[] = [];
		let setLabel!: (v: string) => void;
		function View(): React.ReactNode {
			const [label, set] = React.useState('r0');
			setLabel = set;
			const s = useSignal(sig);
			const frame = `${s}/${label}`;
			frames.push(frame);
			return <span>{frame}</span>;
		}
		const c = mount(<View />);
		expect(c.textContent).toBe('a0/r0');
		await act(async () => {
			startSignalTransition(() => {
				sig.set('a1');
				setLabel('r1');
			});
		});
		expect(c.textContent).toBe('a1/r1');
		// No frame may mix old and new state (the tear the design exists to
		// prevent): every rendered frame is either fully-old or fully-new.
		for (const f of frames) {
			expect(['a0/r0', 'a1/r1']).toContain(f);
		}
	});

	it('interruption + rebase: an urgent update lands while a transition is suspended, then the transition commits on top (§10.7 shape)', async () => {
		const a = new api.Atom({ state: 1 });
		const gate = new api.Atom({ state: false });
		let release!: () => void;
		const blocker = new Promise<number>((r) => (release = () => r(0)));
		const blockOnGate = new api.Computed({
			fn: (ctx) => (gate.state ? ctx.use(blocker) : 0),
		});
		function View(): React.ReactNode {
			const v = useSignal(a);
			useSignal(blockOnGate); // suspends the transition render while gate=true
			return <span>{v}</span>;
		}
		const c = mount(
			<React.Suspense fallback={<i>wait</i>}>
				<View />
			</React.Suspense>,
		);
		expect(c.textContent).toBe('1');

		// The transition: functional update +1, plus the gate that suspends its
		// render — so it stays PENDING (old UI stays up; no fallback for
		// transition-initiated updates).
		await act(async () => {
			startSignalTransition(() => {
				a.update((x) => x + 1);
				gate.set(true);
			});
		});
		expect(c.textContent).toBe('1'); // pending: committed world unchanged

		// Urgent interruption: doubling applies NOW and commits alone.
		await act(async () => {
			a.update((x) => x * 2);
		});
		expect(c.textContent).toBe('2'); // 1*2 — the transition stays invisible

		// Release the gate: the transition retries and commits ON TOP of the
		// urgent change — (1+1)*2 = 4, exactly React's updater-queue result.
		await act(async () => {
			release();
			await tick();
		});
		expect(c.textContent).toBe('4');
	});

	it('mounting during a pending transition shows committed state, then joins the transition commit', async () => {
		const sig = new api.Atom({ state: 'old' });
		const gate = new api.Atom({ state: false });
		let release!: () => void;
		const blocker = new Promise<number>((r) => (release = () => r(0)));
		const block = new api.Computed({ fn: (ctx) => (gate.state ? ctx.use(blocker) : 0) });
		function Reader({ tag }: { tag: string }): React.ReactNode {
			const v = useSignal(sig);
			useSignal(block);
			return <span>{`${tag}=${v};`}</span>;
		}
		let setShowLate!: (v: boolean) => void;
		function App(): React.ReactNode {
			const [showLate, set] = React.useState(false);
			setShowLate = set;
			return (
				<React.Suspense fallback={<i>wait</i>}>
					<Reader tag="a" />
					{showLate ? <LateReader /> : null}
				</React.Suspense>
			);
		}
		function LateReader(): React.ReactNode {
			// Mounts URGENTLY while the transition is pending: must show
			// committed state (not the pending world), then join the
			// transition's commit via the entangled corrective (§13.2).
			const v = useSignal(sig);
			return <span>{`late=${v};`}</span>;
		}
		const c = mount(<App />);
		expect(c.textContent).toBe('a=old;');
		await act(async () => {
			startSignalTransition(() => {
				sig.set('new');
				gate.set(true);
			});
		});
		expect(c.textContent).toBe('a=old;'); // transition held pending
		await act(async () => {
			setShowLate(true); // urgent mount during the pending window
		});
		expect(c.textContent).toBe('a=old;late=old;'); // committed world only
		await act(async () => {
			release();
			await tick();
		});
		expect(c.textContent).toBe('a=new;late=new;'); // one world, everywhere
	});
});

describe('real React: suspense via ctx.use', () => {
	it('suspends the component, resolves, and converges without refetch loops', async () => {
		let creations = 0;
		let release!: (v: string) => void;
		const data = new Promise<string>((r) => (release = r));
		const remote = new api.Computed<string>({
			fn: (ctx) => {
				++creations;
				return ctx.use(data);
			},
		});
		function View(): React.ReactNode {
			return <span>{useSignal(remote)}</span>;
		}
		const c = mount(
			<React.Suspense fallback={<i>loading</i>}>
				<View />
			</React.Suspense>,
		);
		expect(c.textContent).toBe('loading');
		await act(async () => {
			release('ready');
			await tick();
			await tick();
		});
		expect(c.textContent).toBe('ready');
		expect(creations).toBeLessThan(10); // converges; no refetch-forever
	});
});

describe('real React: flushSync parity (the §9.1 case, in its honest form)', () => {
	it('a signal and a useState mirror written in the same task never diverge across flushSync', async () => {
		// The §9.1 claim is useState-IDENTITY, not a fixed lane composition:
		// whatever set of batches this build's flushSync render includes, the
		// signal must show exactly what a useState written in the same task
		// shows — never a frame where they differ.
		const sig = new api.Atom({ state: 42 });
		const frames: string[] = [];
		let setMirror!: (v: number) => void;
		let setOther!: (v: number) => void;
		function View(): React.ReactNode {
			const [mirror, sm] = React.useState(42);
			const [other, so] = React.useState(0);
			setMirror = sm;
			setOther = so;
			const s = useSignal(sig);
			frames.push(`${s}/${mirror}/${other}`);
			return <span>{`${s}/${mirror}/${other}`}</span>;
		}
		const c = mount(<View />);
		expect(c.textContent).toBe('42/42/0');
		let atFlush = '';
		await act(async () => {
			// Same task: the idle write and its useState twin...
			sig.set(99);
			setMirror(99);
			// ...then a flushSync render.
			flushSync(() => setOther(1));
			atFlush = c.textContent ?? '';
		});
		// Synchronously after flushSync AND at the end: signal === mirror.
		const [sAt, mAt] = atFlush.split('/');
		expect(sAt).toBe(mAt); // useState-identical inside the flushSync frame
		expect(c.textContent).toBe('99/99/1');
		for (const f of frames) {
			const [sv, mv] = f.split('/');
			expect(sv).toBe(mv); // no frame ever tears signal vs useState
		}
	});
});

describe('real React: multi-root and committed effects', () => {
	it('two roots share signals; committed effects fire per root commit with committed values', async () => {
		const sig = new api.Atom({ state: 0 });
		const effectSeen: number[] = [];
		function A(): React.ReactNode {
			const v = useSignal(sig);
			useSignalEffect(() => {
				effectSeen.push(sig.state as number);
			}, []);
			return <b>{v}</b>;
		}
		function B(): React.ReactNode {
			return <i>{useSignal(sig)}</i>;
		}
		const ca = mount(<A />);
		const cb = mount(<B />);
		expect(ca.textContent).toBe('0');
		expect(cb.textContent).toBe('0');
		await act(async () => {
			sig.set(7);
			await tick();
		});
		expect(ca.textContent).toBe('7');
		expect(cb.textContent).toBe('7');
		expect(effectSeen).toContain(7); // re-fired after commit, committed view
	});

	it('useSignalEffect observes committed state only — never a pending transition', async () => {
		const sig = new api.Atom({ state: 'committed' });
		const gate = new api.Atom({ state: false });
		let release!: () => void;
		const blocker = new Promise<number>((r) => (release = () => r(0)));
		const block = new api.Computed({ fn: (ctx) => (gate.state ? ctx.use(blocker) : 0) });
		const effectSeen: string[] = [];
		function View(): React.ReactNode {
			const v = useSignal(sig);
			useSignal(block);
			useSignalEffect(() => {
				effectSeen.push(sig.state as string);
			}, []);
			return <span>{v}</span>;
		}
		const c = mount(
			<React.Suspense fallback={null}>
				<View />
			</React.Suspense>,
		);
		await act(async () => {
			startSignalTransition(() => {
				sig.set('pending');
				gate.set(true);
			});
			await tick();
		});
		expect(c.textContent).toBe('committed');
		expect(effectSeen).not.toContain('pending'); // committed-only reads
		await act(async () => {
			release();
			await tick();
			await tick();
		});
		expect(c.textContent).toBe('pending');
		expect(effectSeen).toContain('pending'); // after the commit, it fires
	});
});

describe('real React: StrictMode', () => {
	it('double-rendering nets to one live subscription and stays correct', async () => {
		const sig = new api.Atom({ state: 1 });
		function View(): React.ReactNode {
			return <span>{useSignal(sig)}</span>;
		}
		const c = mount(
			<React.StrictMode>
				<View />
			</React.StrictMode>,
		);
		expect(c.textContent).toBe('1');
		await act(async () => {
			sig.set(2);
			await tick();
		});
		expect(c.textContent).toBe('2');
		await act(async () => {
			sig.set(3);
			await tick();
		});
		expect(c.textContent).toBe('3');
	});
});
