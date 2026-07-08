/**
 * React seam benchmarks: fanout, transition, mount — one scenario per child
 * process, stdout CSV `scenario,contender,stat,ms`.
 *
 * Contenders: `fm1` (these bindings over the signal-seam fork) and `baseline`
 * (a ~35-line stock useSyncExternalStore store, same component shapes).
 * Both run against the fork build (the baseline uses none of the seam).
 *
 *   node bench/react-bench.mjs            # run all scenarios in children
 *   node bench/react-bench.mjs fanout fm1 # run one scenario inline
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const scenarios = ['fanout', 'transition', 'mount'];
const contenders = ['fm1', 'baseline'];

if (process.argv.length < 4) {
	for (const scenario of scenarios) {
		for (const contender of contenders) {
			await new Promise((resolve, reject) => {
				const child = fork(SELF, [scenario, contender], { stdio: 'inherit' });
				child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${scenario}/${contender} exited ${code}`))));
			});
		}
	}
	process.exit(0);
}

const [scenario, contender] = process.argv.slice(2);

// --- environment: jsdom + real timers -------------------------------------
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.Element = dom.window.Element;
globalThis.MutationObserver = dom.window.MutationObserver;

const React = (await import('react')).default ?? (await import('react'));
const ReactDOMClient = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { createElement: h, useSyncExternalStore, startTransition, useState } = React;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (rows) => {
	const sorted = rows.slice().sort((a, b) => a - b);
	return {
		median: sorted[Math.floor(sorted.length / 2)],
		p95: sorted[Math.floor(sorted.length * 0.95)],
	};
};
const emit = (stat, ms) => console.log(`${scenario},${contender},${stat},${ms.toFixed(3)}`);

// --- contender stores -------------------------------------------------------
async function makeStore(n) {
	if (contender === 'fm1') {
		const { atom, set, register, useValue, startTransitionWrite } = await import('../src/index.ts');
		register();
		const cells = Array.from({ length: n }, () => atom(0));
		return {
			useCell: (i) => useValue(cells[i]),
			write: (i, v) => set(cells[i], v),
			writeManyInTransition: (updates) =>
				startTransitionWrite(() => {
					for (const [i, v] of updates) set(cells[i], v);
				}),
		};
	}
	// Baseline: plain store + useSyncExternalStore (~35 lines).
	const values = new Array(n).fill(0);
	const listeners = Array.from({ length: n }, () => new Set());
	return {
		useCell: (i) =>
			useSyncExternalStore(
				(cb) => {
					listeners[i].add(cb);
					return () => listeners[i].delete(cb);
				},
				() => values[i],
			),
		write: (i, v) => {
			values[i] = v;
			listeners[i].forEach((cb) => cb());
		},
		writeManyInTransition: (updates) =>
			startTransition(() => {
				for (const [i, v] of updates) {
					values[i] = v;
					listeners[i].forEach((cb) => cb());
				}
			}),
	};
}

function Cell({ store, i }) {
	return h('span', null, store.useCell(i));
}
function Grid({ store, n, urgentHook }) {
	if (urgentHook) urgentHook();
	return h(
		'div',
		null,
		Array.from({ length: n }, (_, i) => h(Cell, { store, i, key: i })),
	);
}

async function mountRoot(node) {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = ReactDOMClient.createRoot(container);
	flushSync(() => root.render(node));
	return { root, container };
}

if (scenario === 'fanout') {
	const N = 5000;
	const store = await makeStore(N);
	const { container } = await mountRoot(h(Grid, { store, n: N }));
	await sleep(20);
	const rows = [];
	for (let k = 0; k < 200; k++) {
		const i = (k * 37) % N;
		const t0 = performance.now();
		flushSync(() => store.write(i, k + 1));
		rows.push(performance.now() - t0);
	}
	const { median } = stats(rows);
	emit('median-write-to-commit', median);
	void container;
} else if (scenario === 'transition') {
	const N = 2000;
	const store = await makeStore(N);
	let setUrgent;
	function UrgentInput() {
		const [v, setV] = useState(0);
		setUrgent = setV;
		return h('b', null, v);
	}
	await mountRoot(h('div', null, h(UrgentInput), h(Grid, { store, n: N })));
	await sleep(20);
	const updates = Array.from({ length: N }, (_, i) => [i, 100 + i]);
	store.writeManyInTransition(updates);
	const rows = [];
	for (let k = 0; k < 30; k++) {
		await sleep(16);
		const t0 = performance.now();
		flushSync(() => setUrgent(k + 1));
		rows.push(performance.now() - t0);
	}
	const { p95 } = stats(rows);
	emit('urgent-p95-during-transition', p95);
} else if (scenario === 'mount') {
	const N = 5000;
	const rows = [];
	for (let r = 0; r < 5; r++) {
		const store = await makeStore(N);
		const t0 = performance.now();
		await mountRoot(h(Grid, { store, n: N }));
		rows.push(performance.now() - t0);
		await sleep(10);
	}
	const { median } = stats(rows);
	emit('median-mount-5000', median);
}
process.exit(0);
