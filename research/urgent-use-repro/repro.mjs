// Minimal jsdom repro for: urgent-lane React.use(pendingPromise) suspension
// never gets its retry ping on the vendor React build.
//
// Run: node research/urgent-use-repro/repro.mjs
// Resolves react/react-dom through packages/cosignals/node_modules,
// which pnpm links to vendor/react/build/oss-experimental/*.
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
} catch {
  // navigator is a read-only getter on newer node; jsdom's is compatible enough
}

const React = require('react');
const { createRoot } = require('react-dom/client');

console.log('react version:', React.version);

const h = React.createElement;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(ms = 300) {
  // Give scheduler tasks / microtasks / timers plenty of turns.
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(10);
  }
}

async function waitForText(container, text, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (container.textContent === text) return true;
    await sleep(20);
  }
  return container.textContent === text;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeApp({ mode, promise }) {
  // mode: 'use' -> React.use(promise); 'throw' -> legacy thrown thenable
  let setShowExtern;
  function Content() {
    if (mode === 'use') {
      return React.use(promise);
    }
    // legacy thrown-thenable path
    if (Content._value === undefined) {
      promise.then((v) => {
        Content._value = v;
      });
      throw promise;
    }
    return Content._value;
  }
  function App() {
    const [show, setShow] = React.useState(false);
    setShowExtern = setShow;
    return show
      ? h(React.Suspense, { fallback: 'loading' }, h(Content))
      : 'idle';
  }
  return { App, getSetShow: () => setShowExtern };
}

async function runCase(name, { mode, transition }) {
  const { promise, resolve } = deferred();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const { App, getSetShow } = makeApp({ mode, promise });

  root.render(h(App));
  await waitForText(container, 'idle');

  const setShow = getSetShow();
  if (transition) {
    React.startTransition(() => setShow(true));
  } else {
    setShow(true); // urgent (default event priority) lane
  }
  await settle(200);
  const duringPending = container.textContent;

  resolve('done');
  const ok = await waitForText(container, 'done', 2500);
  const after = container.textContent;

  let recovered = null;
  if (!ok) {
    // Diagnostic: does an unrelated urgent update un-wedge it?
    getSetShow()(true);
    recovered = await waitForText(container, 'done', 1500);
  }

  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}  ` +
      `pending="${duringPending}" after-resolve="${after}"` +
      (recovered === null ? '' : ` recovered-by-nudge=${recovered}`),
  );
  root.unmount();
  container.remove();
  return ok;
}

async function runInitialMountCase(name, { mode }) {
  const { promise, resolve } = deferred();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Content() {
    if (mode === 'use') return React.use(promise);
    if (Content._value === undefined) {
      promise.then((v) => {
        Content._value = v;
      });
      throw promise;
    }
    return Content._value;
  }
  root.render(h(React.Suspense, { fallback: 'loading' }, h(Content)));
  await settle(200);
  const duringPending = container.textContent;
  resolve('done');
  const ok = await waitForText(container, 'done', 2500);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}  pending="${duringPending}" after-resolve="${container.textContent}"`,
  );
  root.unmount();
  container.remove();
  return ok;
}

const results = [];
results.push(await runCase('urgent + use(P)          ', { mode: 'use', transition: false }));
results.push(await runCase('transition + use(P)      ', { mode: 'use', transition: true }));
results.push(await runCase('urgent + thrown thenable ', { mode: 'throw', transition: false }));
results.push(await runInitialMountCase('mount(default lane) + use(P)', { mode: 'use' }));

console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
