// Same repro but using React.act like the RTL suites do.
import { createRequire } from 'node:module';

const COSIGNALS = '/Users/jitl/src/alien-signals-opt/packages/cosignals/__resolve__.js';
const require = createRequire(COSIGNALS);

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try {
  globalThis.navigator = dom.window.navigator;
} catch {}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

const h = React.createElement;
const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

async function runCase(name, { awaitedMount }) {
  const { promise, resolve } = deferred();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Content() {
    return h('span', null, React.use(promise));
  }
  const el = h(React.Suspense, { fallback: 'loading' }, h(Content));
  if (awaitedMount) {
    await act(async () => {
      root.render(el);
    });
  } else {
    act(() => {
      root.render(el);
    });
  }
  const pending = container.textContent;
  await act(async () => {
    resolve('done');
    await tick();
    await tick();
  });
  const after = container.textContent;
  const ok = after === 'done';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  pending="${pending}" after="${after}"`);
  await act(async () => root.unmount());
  container.remove();
  return ok;
}

const results = [];
results.push(await runCase('sync act mount + use(P)   ', { awaitedMount: false }));
results.push(await runCase('awaited act mount + use(P)', { awaitedMount: true }));
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
