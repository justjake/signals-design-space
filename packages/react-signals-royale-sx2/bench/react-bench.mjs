import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scenario = process.argv[2];
const contender = process.argv[3];
const scenarios = ["fanout", "transition", "mount"];
const contenders = ["sx2", "uses"];

if (scenario === undefined) {
  process.stdout.write("scenario,contender,stat,ms\n");
  for (const name of scenarios) {
    for (const entry of contenders) {
      const child = spawnSync(
        process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url), name, entry],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      process.stdout.write(child.stdout);
      if (child.status !== 0) process.exit(child.status ?? 1);
    }
  }
  process.exit(0);
}

if (!scenarios.includes(scenario) || !contenders.includes(contender)) {
  throw new Error("expected a scenario and contender: fanout|transition|mount sx2|uses");
}

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const bindings = await import("../src/index.ts");
const signals = await import("signals-royale-sx2");
const registration = bindings.register();

function stockStore(count) {
  const values = new Array(count).fill(0);
  const listeners = new Array(count);
  for (let index = 0; index < count; index++) listeners[index] = new Set();
  return {
    useCell(index) {
      return React.useSyncExternalStore(
        (listener) => {
          listeners[index].add(listener);
          return () => listeners[index].delete(listener);
        },
        () => values[index],
        () => values[index],
      );
    },
    write(index, value) {
      if (Object.is(values[index], value)) return;
      values[index] = value;
      for (const listener of listeners[index]) listener();
    },
    transition(value) {
      React.startTransition(() => {
        for (let index = 0; index < count; index++) this.write(index, value);
      });
    },
    dispose() {
      for (const set of listeners) set.clear();
    },
  };
}

function sx2Store(count) {
  const cells = new Array(count);
  for (let index = 0; index < count; index++) cells[index] = signals.atom(0);
  return {
    useCell(index) {
      return bindings.useValue(cells[index]);
    },
    write(index, value) {
      bindings.write(cells[index], value);
    },
    transition(value) {
      bindings.startTransitionWrite(() => {
        for (let index = 0; index < count; index++) {
          bindings.write(cells[index], value);
        }
      });
    },
    dispose() {
      cells.length = 0;
    },
  };
}

function makeStore(count) {
  return contender === "sx2" ? sx2Store(count) : stockStore(count);
}

function timeout(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${scenario} commit timed out`)),
      30_000,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function median(samples) {
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function Cell({ index, store, committed }) {
  const value = store.useCell(index);
  React.useLayoutEffect(() => committed?.(index, value), [index, value, committed]);
  return React.createElement("span", null, value);
}

function Tree({ count, store, committed, mounted, urgent }) {
  React.useLayoutEffect(() => mounted?.(), [mounted]);
  const children = new Array(count + (urgent === undefined ? 0 : 1));
  for (let index = 0; index < count; index++) {
    children[index] = React.createElement(Cell, {
      key: index,
      index,
      store,
      committed,
    });
  }
  if (urgent !== undefined) children[count] = React.createElement(urgent, { key: "urgent" });
  return React.createElement("div", null, children);
}

async function mountedRoot(count, store, options = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let resolve;
  const mounted = new Promise((done) => {
    resolve = done;
  });
  root.render(React.createElement(Tree, { count, store, ...options, mounted: resolve }));
  await timeout(mounted);
  return { root, container };
}

async function fanout() {
  const count = 5000;
  const store = makeStore(count);
  const waiting = new Map();
  const committed = (index) => {
    const done = waiting.get(index);
    if (done !== undefined) {
      waiting.delete(index);
      done();
    }
  };
  const view = await mountedRoot(count, store, { committed });
  const samples = [];
  for (let write = 1; write <= 200; write++) {
    const index = (write * 1543) % count;
    let resolve;
    const commit = new Promise((done) => {
      resolve = done;
    });
    waiting.set(index, resolve);
    const start = performance.now();
    store.write(index, write);
    await timeout(commit);
    samples.push(performance.now() - start);
  }
  view.root.unmount();
  view.container.remove();
  store.dispose();
  return ["median_write_commit", median(samples)];
}

async function transition() {
  const count = 2000;
  const store = makeStore(count);
  const seen = new Uint8Array(count);
  let remaining = count;
  let finishTransition;
  const transitionDone = new Promise((done) => {
    finishTransition = done;
  });
  const committed = (index, value) => {
    if (value === 1 && seen[index] === 0) {
      seen[index] = 1;
      if (--remaining === 0) finishTransition();
    }
  };
  const starts = new Array(31);
  const samples = [];
  let setUrgent;
  let measured = 0;
  let finishUrgent;
  const urgentDone = new Promise((done) => {
    finishUrgent = done;
  });
  function Urgent() {
    const [value, setValue] = React.useState(0);
    setUrgent = setValue;
    React.useLayoutEffect(() => {
      const committedAt = performance.now();
      while (measured < value) samples.push(committedAt - starts[++measured]);
      if (value === 30) finishUrgent();
    }, [value]);
    return React.createElement("input", { value, readOnly: true });
  }
  const view = await mountedRoot(count, store, { committed, urgent: Urgent });
  let update = 0;
  const inputStart = performance.now();
  const interval = setInterval(() => {
    starts[++update] = inputStart + update * 16;
    setUrgent(update);
    if (update === 30) clearInterval(interval);
  }, 16);
  store.transition(1);
  await timeout(Promise.all([urgentDone, transitionDone]));
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  view.root.unmount();
  view.container.remove();
  store.dispose();
  return ["p95_urgent_commit", p95];
}

async function mount() {
  const samples = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const store = makeStore(5000);
    const start = performance.now();
    const view = await mountedRoot(5000, store);
    samples.push(performance.now() - start);
    view.root.unmount();
    view.container.remove();
    store.dispose();
  }
  return ["median_mount", median(samples)];
}

const [stat, milliseconds] = await { fanout, transition, mount }[scenario]();
registration.dispose();
dom.window.close();
process.stdout.write(`${scenario},${contender},${stat},${milliseconds.toFixed(3)}\n`);
