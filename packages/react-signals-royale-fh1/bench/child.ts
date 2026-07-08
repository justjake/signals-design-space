/**
 * One benchmark scenario in one process: jsdom + real timers, real createRoot
 * from this package's fork build. Invoked by react-bench.mjs; prints CSV
 * `scenario,contender,stat,ms` on stdout.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
g.Element = dom.window.Element;
g.HTMLElement = dom.window.HTMLElement;
g.MutationObserver = dom.window.MutationObserver;

// Imports come after the DOM globals exist (react-dom probes them at load).
/* eslint-disable import/first */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useSyncExternalStore, useState, startTransition } from 'react';
import { atom, batch, type Atom } from 'signals-royale-fh1';
import { register, startTransitionWrite } from '../src/seam';
import { useValue } from '../src/hooks';

const [, , scenario, contender] = process.argv;

// BLOCK MONITOR: report main-thread stalls > 20ms.
if (process.env.BENCH_PROBE) {
	let last = performance.now();
	setInterval(() => {
		const now = performance.now();
		if (now - last > 20) process.stderr.write(`# block ${(now - last).toFixed(0)}ms at ${now.toFixed(0)}\n`);
		last = now;
	}, 4).unref();
}

interface Store {
	useCell(i: number): number;
	write(i: number, v: number): void;
	writeManyInTransition(updates: Array<[number, number]>): void;
}

function royaleStore(n: number): Store {
	const host = register();
	// SEAM-LOG
	if (process.env.BENCH_PROBE) {
		const rt = (host.seam as any).runtime;
		for (const k of ['onPassStart', 'onCommit'] as const) {
			const orig = rt[k].bind(rt);
			rt[k] = (...args: unknown[]) => {
				process.stderr.write(`# ${k} lanes=${String(args[1])} rem=${String(args[2] ?? '')} at ${performance.now().toFixed(0)}\n`);
				orig(...args);
			};
		}
	}
	const cells: Atom<number>[] = [];
	for (let i = 0; i < n; i++) cells.push(atom(0));
	return {
		useCell: (i) => useValue(cells[i]),
		write: (i, v) => cells[i].set(v),
		writeManyInTransition(updates) {
			startTransitionWrite(() => {
				batch(() => {
					for (const [i, v] of updates) cells[i].set(v);
				});
			});
		},
	};
}

/** The stock comparison point: a plain store consumed via useSyncExternalStore. */
function baselineStore(n: number): Store {
	const values = new Array<number>(n).fill(0);
	const subs = new Set<() => void>();
	const notify = () => {
		for (const cb of [...subs]) cb();
	};
	return {
		useCell(i: number): number {
			return useSyncExternalStore(
				(cb) => {
					subs.add(cb);
					return () => subs.delete(cb);
				},
				() => values[i],
			);
		},
		write(i, v) {
			values[i] = v;
			notify();
		},
		writeManyInTransition(updates) {
			startTransition(() => {
				for (const [i, v] of updates) values[i] = v;
				notify();
			});
		},
	};
}

const makeStore = contender === 'royale-fh1' ? royaleStore : baselineStore;

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(pred: () => boolean, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('timeout waiting for commit');
		await tick();
	}
}

function stats(xs: number[]): { median: number; p95: number } {
	const s = [...xs].sort((a, b) => a - b);
	return {
		median: s[Math.floor(s.length / 2)],
		p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
	};
}

function row(stat: string, ms: number): void {
	process.stdout.write(`${scenario},${contender},${stat},${ms.toFixed(3)}\n`);
}

function mountTree(store: Store, n: number): { container: HTMLElement; unmount(): void } {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	function Cell({ i }: { i: number }) {
		return React.createElement('i', null, store.useCell(i));
	}
	const kids: React.ReactNode[] = [];
	for (let i = 0; i < n; i++) kids.push(React.createElement(Cell, { i, key: i }));
	root.render(React.createElement('div', null, kids));
	return {
		container,
		unmount() {
			root.unmount();
			container.remove();
		},
	};
}

async function fanout(): Promise<void> {
	const N = 5000;
	const store = makeStore(N);
	const { container, unmount } = mountTree(store, N);
	await until(() => container.querySelectorAll('i').length === N);
	const cells = container.querySelectorAll('i');
	const lat: number[] = [];
	for (let w = 0; w < 200; w++) {
		const i = (w * 37) % N;
		const v = w + 1;
		const t0 = performance.now();
		store.write(i, v);
		await until(() => cells[i].textContent === String(v));
		lat.push(performance.now() - t0);
	}
	row('median-write-to-commit', stats(lat).median);
	unmount();
}

async function transition(): Promise<void> {
	const N = 2000;
	const store = makeStore(N);
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	let setUrgent!: (v: number) => void;
	function Input() {
		const [u, setU] = useState(0);
		setUrgent = setU;
		// URGENT-COMMIT-LOG
		React.useLayoutEffect(() => {
			if (process.env.BENCH_PROBE) process.stderr.write(`# urgent ${u} committed at ${performance.now().toFixed(0)}\n`);
		}, [u]);
		return React.createElement('b', { id: 'urgent' }, u);
	}
	function Cell({ i }: { i: number }) {
		const v = store.useCell(i);
		// Enough render work that 2000 cells span many time slices: the
		// scenario exists to measure urgent latency WHILE this renders.
		const end = performance.now() + 0.2;
		while (performance.now() < end) {
			/* spin */
		}
		return React.createElement('i', null, v);
	}
	const kids: React.ReactNode[] = [React.createElement(Input, { key: 'u' })];
	for (let i = 0; i < N; i++) kids.push(React.createElement(Cell, { i, key: i }));
	root.render(React.createElement('div', null, kids));
	await until(() => container.querySelectorAll('i').length === N);
	const urgentEl = () => container.querySelector('#urgent')!;

	const updates: Array<[number, number]> = [];
	for (let i = 0; i < N; i++) updates.push([i, 7]);
	// The bulk rewrite starts two samples into the urgent cadence, so the
	// transition render overlaps the sampling window for both contenders.
	setTimeout(() => {
		store.writeManyInTransition(updates);
		if (process.env.BENCH_PROBE) {
			const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
			process.stderr.write(`# after transition scope: T=${String(internals.T)} pin=${internals.signalSeam?.pinnedTransitionLane} at ${performance.now().toFixed(0)}\n`);
		}
	}, 40);

	// Absolute-time cadence: each urgent update is scheduled at tStart+16k, and
	// its latency is measured from that intended moment to its commit — a
	// blocking render shows up as timer lateness, not a skipped sample.
	const lat: number[] = [];
	const tStart = performance.now();
	const done: Array<Promise<void>> = [];
	for (let k = 1; k <= 30; k++) {
		const intended = tStart + 16 * k;
		done.push(
			new Promise<void>((resolve) => {
				setTimeout(
					() => {
						// Discrete-input priority: real user events flush synchronously
						// and may interrupt a transition render; timer-context setState
						// would be DefaultLane, which React deliberately parks behind
						// transitions.
						flushSync(() => setUrgent(k));
						void until(() => Number(urgentEl().textContent) >= k).then(() => {
							lat.push(performance.now() - intended);
							resolve();
						});
					},
					Math.max(0, intended - performance.now()),
				);
			}),
		);
	}
	await Promise.all(done);
	await until(() => container.querySelectorAll('i')[N - 1].textContent === '7', 120_000);
	process.stderr.write(`# transition completed in ${(performance.now() - tStart).toFixed(0)}ms\n`);
	row('p95-urgent-during-transition', stats(lat).p95);
	root.unmount();
}

async function mountBench(): Promise<void> {
	const N = 5000;
	const times: number[] = [];
	for (let r = 0; r < 5; r++) {
		const store = makeStore(N);
		const t0 = performance.now();
		const { container, unmount } = mountTree(store, N);
		await until(() => container.querySelectorAll('i').length === N);
		times.push(performance.now() - t0);
		unmount();
		await tick();
	}
	row('median-mount', stats(times).median);
}

const scenarios: Record<string, () => Promise<void>> = {
	fanout,
	transition,
	mount: mountBench,
};

scenarios[scenario]()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
