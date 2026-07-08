/**
 * One benchmark child: SCENARIO x CONTENDER per process (JIT, GC, and
 * polymorphism isolation). jsdom + real timers, no act. Prints CSV rows
 * `scenario,contender,stat,ms` on stdout; diagnostics on stderr.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.MutationObserver = dom.window.MutationObserver;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const royale = await import('../src/index.ts');
const engine = await import('signals-royale-fh2');

const SCENARIO = process.env.BENCH_SCENARIO;
const CONTENDER = process.env.BENCH_CONTENDER;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}
function p95(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

/** The contender surface: n cells, a per-cell hook, writes, transitions. */
function makeStore(n) {
	if (CONTENDER === 'royale-fh2') {
		royale.registerReactSignals();
		const cells = Array.from({ length: n }, () => engine.atom(0));
		return {
			useCell: (i) => royale.useValue(cells[i]),
			write: (i, v) => engine.set(cells[i], v),
			writeAllInTransition: (v) => {
				royale.startTransitionWrite(() => {
					for (let i = 0; i < n; i++) {
						engine.set(cells[i], v);
					}
				});
			},
		};
	}
	// The stock reference point: a plain store read through
	// useSyncExternalStore (how nearly every signal library meets React).
	const values = new Array(n).fill(0);
	const listeners = Array.from({ length: n }, () => new Set());
	const subscribe = (i) => (cb) => {
		listeners[i].add(cb);
		return () => listeners[i].delete(cb);
	};
	const subs = Array.from({ length: n }, (_, i) => subscribe(i));
	const notify = (i) => {
		for (const cb of listeners[i]) {
			cb();
		}
	};
	return {
		useCell: (i) => React.useSyncExternalStore(subs[i], () => values[i]),
		write: (i, v) => {
			values[i] = v;
			notify(i);
		},
		writeAllInTransition: (v) => {
			React.startTransition(() => {
				for (let i = 0; i < n; i++) {
					values[i] = v;
					notify(i);
				}
			});
		},
	};
}

function makeTree(store, n, withInput) {
	const Cell = ({ i }) => React.createElement('span', null, store.useCell(i));
	const MemoCell = React.memo(Cell);
	let setUrgentRef = { current: null };
	function Input() {
		const [v, setV] = React.useState(0);
		setUrgentRef.current = setV;
		return React.createElement('b', { id: 'urgent' }, v);
	}
	function App() {
		const kids = [];
		if (withInput) {
			kids.push(React.createElement(Input, { key: 'input' }));
		}
		for (let i = 0; i < n; i++) {
			kids.push(React.createElement(MemoCell, { key: i, i }));
		}
		return React.createElement('div', null, kids);
	}
	return { App, setUrgentRef };
}

async function waitFor(pred, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) {
			throw new Error('timeout waiting for commit');
		}
		await tick(0);
	}
}

const out = (stat, ms) => console.log(`${SCENARIO},${CONTENDER},${stat},${ms.toFixed(3)}`);

if (SCENARIO === 'fanout') {
	const N = 5000;
	const store = makeStore(N);
	const { App } = makeTree(store, N, false);
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(React.createElement(App));
	await waitFor(() => container.querySelectorAll('span').length === N);
	const spans = container.querySelectorAll('span');
	const lat = [];
	for (let k = 0; k < 200; k++) {
		const i = (k * 25) % N;
		const v = String(k + 1);
		const t0 = performance.now();
		store.write(i, k + 1);
		await waitFor(() => spans[i].textContent === v);
		lat.push(performance.now() - t0);
	}
	out('write-to-commit-median', median(lat));
	root.unmount();
} else if (SCENARIO === 'transition') {
	const N = 2000;
	const store = makeStore(N);
	const { App, setUrgentRef } = makeTree(store, N, true);
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(React.createElement(App));
	await waitFor(() => container.querySelectorAll('span').length === N);
	const urgentEl = () => container.querySelector('#urgent');
	const lat = [];
	// Urgent sampling brackets the transition: the first writes land before
	// the bulk write so a store that blocks synchronously at write time
	// pays its block inside the measurement window.
	const t0 = performance.now();
	let started = false;
	for (let j = 1; j <= 30; j++) {
		if (j === 3 && !started) {
			started = true;
			store.writeAllInTransition(7);
		}
		const t1 = performance.now();
		setUrgentRef.current(j);
		await waitFor(() => urgentEl().textContent === String(j));
		lat.push(performance.now() - t1);
		const wait = 16 - (performance.now() - t1);
		if (wait > 0) {
			await tick(wait);
		}
	}
	await waitFor(() => container.querySelectorAll('span')[0].textContent === '7');
	console.error(`# ${CONTENDER} transition completed in ${(performance.now() - t0).toFixed(1)}ms`);
	console.error(`# ${CONTENDER} urgent latencies: ${lat.map((x) => x.toFixed(1)).join(' ')}`);
	out('urgent-p95', p95(lat));
	root.unmount();
} else if (SCENARIO === 'mount') {
	const N = 5000;
	const times = [];
	for (let r = 0; r < 5; r++) {
		const store = makeStore(N);
		const { App } = makeTree(store, N, false);
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		const t0 = performance.now();
		root.render(React.createElement(App));
		await waitFor(() => container.querySelectorAll('span').length === N);
		times.push(performance.now() - t0);
		root.unmount();
		container.remove();
	}
	out('mount-median', median(times));
} else {
	throw new Error(`unknown scenario ${SCENARIO}`);
}
process.exit(0);
