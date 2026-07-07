// cosignals side of the React retirement measurement: jsdom + React + the
// cosignals-react hooks (test-setup style; timing at this level is COARSE).
// N components useSignal(shared atom); one round = `await act(() => a.set(v))`
// — the write's batch retires inside the round (verified: no live batches,
// history compacted after each act). Metric: wall ms per round (render/commit
// for N reached watchers), median across rounds, plus bridge-state steadiness.
import { createRequire } from 'node:module';
const ROOT = process.env.COSIGNAL_ROOT ?? '/Users/jitl/src/alien-signals-opt';
const req = createRequire(`${ROOT}/packages/cosignals-react/tests/helpers.tsx`);
const { JSDOM } = req('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { globalThis.navigator = dom.window.navigator; } catch { Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true }); }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = req('react');
const { createRoot } = req('react-dom/client');
const { act } = React;

const mod = await import(`${ROOT}/packages/cosignals/src/index.ts`);
const { Atom } = mod;
const { registerCosignalReact, useSignal } = await import(`${ROOT}/packages/cosignals-react/src/index.ts`);
const { envInt, row } = await import('/Users/jitl/src/alien-signals-opt/packages/cosignals/bench/util.mjs');

const N = envInt('N', 64); // components (reached watchers)
const ROUNDS = envInt('ROUNDS', 30);
const WARMUP = envInt('WARMUP', 5);

// A/B seam (COSIGNAL_ROOT swaps trees): the anchor tree injects a per-test
// bridge into the bindings; this tree has ONE module engine and the
// bindings attach to it — registerCosignalReact() takes nothing.
const oldTree = typeof mod.__newBridgeForTest === 'function';
const bridge = oldTree ? mod.__newBridgeForTest() : mod.engine;
const handle = oldTree ? registerCosignalReact({ bridge }) : registerCosignalReact();
const a = new Atom(0);

function Cell() {
	return React.createElement('span', null, String(useSignal(a)));
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
	await act(async () => { a.set(++v); });
	const t1 = process.hrtime.bigint();
	return Number(t1 - t0) / 1e6;
}

for (let r = 0; r < WARMUP; r++) await round();
const times = [];
for (let r = 0; r < ROUNDS; r++) times.push(await round());
times.sort((x, y) => x - y);
const node = oldTree ? bridge.kernelIdToNode.get(a._id) : bridge.idToNode !== undefined ? bridge.idToNode.get(a._id) : mod.__internalsByIdForTest(a._id);
const checksum = container.textContent.length + Number(bridge.newestValue(node));
row({
	gate: 'SPK-R', config: 'react-cosignals', shape: `N${N}`,
	metric: `roundMs:N${N}`, value: times[times.length >> 1], checksum,
});
row({
	gate: 'SPK-R', config: 'react-cosignals', shape: `N${N}`,
	metric: `steadyLog:N${N}`, value: node.log.length + bridge.liveBatches().length, checksum,
});
handle.dispose?.();
