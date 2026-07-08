/**
 * React seam benchmark: fanout, transition, mount — run against this
 * package's bindings and a stock useSyncExternalStore baseline over a plain
 * store (same component shapes). jsdom + real timers, no act(); one scenario
 * per child process; stdout CSV `scenario,contender,stat,ms`.
 *
 * Leak note: each child process builds and drops its whole tree; the
 * engine holds no per-episode state at quiescence (see the leak audit in
 * signals-royale-fm2/tests/gc-leaks.spec.ts). No leak-based speedups here.
 *
 * Run: node bench/react-bench.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const scenario = process.env.BENCH_SCENARIO;
const contender = process.env.BENCH_CONTENDER;

if (!scenario) {
	// Parent: one child per scenario x contender.
	process.stdout.write('scenario,contender,stat,ms\n');
	for (const s of ['fanout', 'transition', 'mount']) {
		for (const c of ['royale-fm2', 'stock-uses']) {
			const r = spawnSync(process.execPath, ['--experimental-strip-types', '--expose-gc', SELF], {
				env: { ...process.env, BENCH_SCENARIO: s, BENCH_CONTENDER: c },
				encoding: 'utf8',
			});
			if (r.status !== 0) {
				console.error(`child failed: ${s}/${c}\n${r.stderr}`);
				process.exit(1);
			}
			process.stdout.write(r.stdout);
		}
	}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Child: set up jsdom, load React from this package's fork build.
// ---------------------------------------------------------------------------
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.MutationObserver = dom.window.MutationObserver;

const React = (await import('react')).default ?? (await import('react'));
const { createRoot } = await import('react-dom/client');

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}
function p95(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until pred() is true (polling with real timers). */
async function until(pred, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('timeout waiting for condition');
		await sleep(0);
	}
}

// ---------------------------------------------------------------------------
// Contender stores: same component shapes, different subscription seams.
// ---------------------------------------------------------------------------
async function makeStore(n) {
	if (contender === 'royale-fm2') {
		const engine = await import('signals-royale-fm2');
		const host = await import('../src/index.ts');
		host.register();
		const cells = Array.from({ length: n }, () => engine.atom(0));
		return {
			useCell: (i) => host.useValue(cells[i]),
			write: (i, v) => engine.set(cells[i], v),
			writeManyInTransition(updates) {
				host.startTransitionWrite(() => {
					for (const [i, v] of updates) engine.set(cells[i], v);
				});
			},
		};
	}
	// Stock baseline: plain versioned store + useSyncExternalStore.
	const values = new Array(n).fill(0);
	const listeners = new Set();
	const store = {
		subscribe(l) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		notify() {
			for (const l of [...listeners]) l();
		},
	};
	return {
		useCell: (i) =>
			React.useSyncExternalStore(
				store.subscribe,
				() => values[i],
				() => values[i],
			),
		write(i, v) {
			values[i] = v;
			store.notify();
		},
		writeManyInTransition(updates) {
			React.startTransition(() => {
				for (const [i, v] of updates) values[i] = v;
				store.notify();
			});
		},
	};
}

function Cell({ store, i }) {
	return React.createElement('i', null, store.useCell(i));
}
function Grid({ store, n }) {
	const kids = [];
	for (let i = 0; i < n; i++) kids.push(React.createElement(Cell, { store, i, key: i }));
	return React.createElement('div', null, kids);
}

const container = document.getElementById('root');

async function commitLatency(fn, observedNode) {
	return new Promise((resolve) => {
		const t0 = performance.now();
		const mo = new MutationObserver(() => {
			mo.disconnect();
			resolve(performance.now() - t0);
		});
		mo.observe(observedNode, { childList: true, characterData: true, subtree: true });
		fn();
	});
}

if (scenario === 'fanout') {
	const N = 5000;
	const store = await makeStore(N);
	const root = createRoot(container);
	root.render(React.createElement(Grid, { store, n: N }));
	await until(() => container.textContent.length >= N);
	const lat = [];
	for (let k = 0; k < 200; k++) {
		const i = (k * 37) % N;
		lat.push(await commitLatency(() => store.write(i, k + 1), container));
	}
	console.log(`fanout,${contender},median,${median(lat).toFixed(3)}`);
	root.unmount();
} else if (scenario === 'transition') {
	const N = 2000;
	const store = await makeStore(N);
	let setInput;
	function Input() {
		const [v, set] = React.useState(0);
		setInput = set;
		return React.createElement('b', null, 'u', v);
	}
	const root = createRoot(container);
	root.render(
		React.createElement(
			'div',
			null,
			React.createElement(Input),
			React.createElement(Grid, { store, n: N }),
		),
	);
	await until(() => container.textContent.includes('u0'));
	// Large transition rewrite, then 30 urgent input updates at ~16ms.
	// blockMs exposes de-opted contenders: a store that falls back to a
	// synchronous render pays the whole rewrite inside this call.
	const tb = performance.now();
	store.writeManyInTransition(Array.from({ length: N }, (_, i) => [i, 7]));
	const blockMs = performance.now() - tb;
	const lat = [];
	for (let k = 1; k <= 30; k++) {
		const target = `u${k}`;
		const t0 = performance.now();
		setInput(k);
		await until(() => container.textContent.includes(target));
		lat.push(performance.now() - t0);
		await sleep(16);
	}
	console.log(`transition,${contender},p95,${p95(lat).toFixed(3)}`);
	console.log(`transition,${contender},block,${blockMs.toFixed(3)}`);
	root.unmount();
} else if (scenario === 'mount') {
	const N = 5000;
	const times = [];
	for (let r = 0; r < 5; r++) {
		const store = await makeStore(N);
		const el = document.createElement('div');
		document.body.appendChild(el);
		const t0 = performance.now();
		const root = createRoot(el);
		root.render(React.createElement(Grid, { store, n: N }));
		await until(() => el.textContent.length >= N);
		times.push(performance.now() - t0);
		root.unmount();
		el.remove();
		if (globalThis.gc) globalThis.gc();
	}
	console.log(`mount,${contender},median,${median(times).toFixed(3)}`);
}
process.exit(0);
