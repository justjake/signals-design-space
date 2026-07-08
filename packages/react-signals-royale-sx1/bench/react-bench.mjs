import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scenarios = ["fanout", "transition", "mount"];
const contenders = ["sx1", "useSyncExternalStore"];
const argv = process.argv.slice(2);

if (argv[0] !== "--child") {
  process.stdout.write("scenario,contender,stat,ms\n");
  for (const scenario of scenarios) {
    for (const contender of contenders) {
      const result = spawnSync(
        process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url), "--child", scenario, contender],
        {
          encoding: "utf8",
          env: { ...process.env, NODE_ENV: "production" },
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status !== 0) process.exit(result.status ?? 1);
      process.stdout.write(result.stdout);
    }
  }
  process.exit(0);
}

const scenario = argv[1];
const contender = argv[2];
if (!scenarios.includes(scenario) || !contenders.includes(contender)) process.exit(2);

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  MutationObserver: { configurable: true, value: dom.window.MutationObserver },
  requestAnimationFrame: {
    configurable: true,
    value: dom.window.requestAnimationFrame.bind(dom.window),
  },
  cancelAnimationFrame: {
    configurable: true,
    value: dom.window.cancelAnimationFrame.bind(dom.window),
  },
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const sx1 = await import("../src/index.ts");

function stockCell(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    read: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write(next) {
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

function makeCells(count) {
  const cells = new Array(count);
  for (let index = 0; index < count; index++) {
    cells[index] = contender === "sx1" ? sx1.atom(index) : stockCell(index);
  }
  return cells;
}

function useCell(cell) {
  return contender === "sx1"
    ? sx1.useValue(cell)
    : React.useSyncExternalStore(cell.subscribe, cell.read, cell.read);
}

function writeCell(cell, value) {
  if (contender === "sx1") sx1.set(cell, value);
  else cell.write(value);
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length & 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function p95(values) {
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * 0.95) - 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const Cell = React.memo(function Cell({ cell, index, committed }) {
  const value = useCell(cell);
  React.useLayoutEffect(() => committed(index, value), [committed, index, value]);
  return React.createElement("span", { "data-cell": index }, value);
});

async function fanout() {
  const cells = makeCells(5000);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let mounted;
  const mountedPromise = new Promise((resolve) => (mounted = resolve));
  let wantedIndex = -1;
  let wantedValue = -1;
  let resolveCommit;
  const committed = (index, value) => {
    if (index === wantedIndex && value === wantedValue) {
      wantedIndex = -1;
      resolveCommit();
    }
  };
  function Tree() {
    const children = new Array(cells.length);
    for (let index = 0; index < cells.length; index++) {
      children[index] = React.createElement(Cell, {
        cell: cells[index],
        committed,
        index,
        key: index,
      });
    }
    React.useLayoutEffect(mounted, []);
    return React.createElement("div", null, children);
  }
  root.render(React.createElement(Tree));
  await mountedPromise;
  const times = [];
  for (let iteration = 0; iteration < 200; iteration++) {
    wantedIndex = iteration;
    wantedValue = 5001 + iteration;
    const done = new Promise((resolve) => (resolveCommit = resolve));
    const start = performance.now();
    writeCell(cells[wantedIndex], wantedValue);
    await done;
    times.push(performance.now() - start);
  }
  root.unmount();
  return ["median", median(times)];
}

async function mount() {
  const times = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    const cells = makeCells(5000);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let mounted;
    const done = new Promise((resolve) => (mounted = resolve));
    const committed = () => {};
    function Tree() {
      const children = new Array(cells.length);
      for (let index = 0; index < cells.length; index++) {
        children[index] = React.createElement(Cell, {
          cell: cells[index],
          committed,
          index,
          key: index,
        });
      }
      React.useLayoutEffect(mounted, []);
      return React.createElement("div", null, children);
    }
    const start = performance.now();
    root.render(React.createElement(Tree));
    await done;
    times.push(performance.now() - start);
    root.unmount();
    container.remove();
  }
  return ["median", median(times)];
}

async function transition() {
  const cells = makeCells(2000);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let mounted;
  const mountedPromise = new Promise((resolve) => (mounted = resolve));
  let setUrgent;
  let urgentValue = 0;
  let resolveUrgent;
  let resolveTransition;
  const transitionDone = new Promise((resolve) => (resolveTransition = resolve));
  const committed = (index, value) => {
    if (index === cells.length - 1 && value === 10_000 + index) resolveTransition();
  };
  function Urgent() {
    const [value, setValue] = React.useState(0);
    setUrgent = setValue;
    React.useLayoutEffect(() => {
      if (value === urgentValue) resolveUrgent?.();
    }, [value]);
    return React.createElement("input", { readOnly: true, value });
  }
  function Tree() {
    const children = new Array(cells.length + 1);
    children[0] = React.createElement(Urgent, { key: "urgent" });
    for (let index = 0; index < cells.length; index++) {
      children[index + 1] = React.createElement(Cell, {
        cell: cells[index],
        committed,
        index,
        key: index,
      });
    }
    React.useLayoutEffect(mounted, []);
    return React.createElement("div", null, children);
  }
  root.render(React.createElement(Tree));
  await mountedPromise;
  setTimeout(() => {
    const rewrite = () => {
      for (let index = 0; index < cells.length; index++) writeCell(cells[index], 10_000 + index);
    };
    if (contender === "sx1") sx1.startTransitionWrite(rewrite);
    else React.startTransition(rewrite);
  }, 0);
  const times = [];
  for (let iteration = 1; iteration <= 30; iteration++) {
    await sleep(16);
    urgentValue = iteration;
    const done = new Promise((resolve) => (resolveUrgent = resolve));
    const start = performance.now();
    setUrgent(iteration);
    await done;
    times.push(performance.now() - start);
  }
  await transitionDone;
  root.unmount();
  return ["p95", p95(times)];
}

const [stat, ms] = await { fanout, transition, mount }[scenario]();
process.stdout.write(`${scenario},${contender},${stat},${ms.toFixed(3)}\n`);
dom.window.close();
