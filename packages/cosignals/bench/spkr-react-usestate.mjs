// Plain-useState comparator for the React retirement measurement (same
// React build, no cosignals registered). N components each hold useState and
// register their setter in a shared list; one round = one act() calling
// every setter with the same new value — the equivalent render/commit for N
// reached watchers. COARSE timing, same protocol as the cosignals child.
import { createRequire } from 'node:module';
const req = createRequire('/Users/jitl/src/alien-signals-opt/packages/cosignals-react/tests/helpers.tsx');
const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { globalThis.navigator = dom.window.navigator; } catch { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }); }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = req('react');
const { createRoot } = req('react-dom/client');
const { act } = React;
const { envInt, row } = await import('/Users/jitl/src/alien-signals-opt/packages/cosignals/bench/util.mjs');

const N = envInt('N', 64);
const ROUNDS = envInt('ROUNDS', 30);
const WARMUP = envInt('WARMUP', 5);

const setters = [];
function Cell() {
	const [v, setV] = React.useState(0);
	React.useEffect(() => {
		setters.push(setV);
		return () => setters.splice(setters.indexOf(setV), 1);
	}, []);
	return React.createElement('span', null, String(v));
}
function App() {
	const cells = [];
	for (let i = 0; i < N; i++) cells.push(React.createElement(Cell, { key: i }));
	return React.createElement('div', null, cells);
}

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => { root.render(React.createElement(App)); });

let v = 0;
async function round() {
	const t0 = process.hrtime.bigint();
	await act(async () => {
		++v;
		for (const s of setters) s(v);
	});
	const t1 = process.hrtime.bigint();
	return Number(t1 - t0) / 1e6;
}

for (let r = 0; r < WARMUP; r++) await round();
const times = [];
for (let r = 0; r < ROUNDS; r++) times.push(await round());
times.sort((x, y) => x - y);
row({
	gate: 'SPK-R', config: 'react-usestate', shape: `N${N}`,
	metric: `roundMs:N${N}`, value: times[times.length >> 1],
	checksum: container.textContent.length + setters.length,
});
