import { spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";

const childAt = process.argv.indexOf("--child");
if (childAt === -1) {
  console.log("scenario,contender,stat,ms");
  for (const scenario of ["fanout", "transition", "mount"]) {
    for (const contender of ["sh2", "useSyncExternalStore"]) {
      const result = spawnSync(
        process.execPath,
        [new URL(import.meta.url).pathname, "--child", scenario, contender],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      if (result.status !== 0) process.exit(result.status ?? 1);
      process.stdout.write(result.stdout);
    }
  }
  process.exit(0);
}

const scenario = process.argv[childAt + 1];
const contender = process.argv[childAt + 2];
const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const [name, value] of [
  ["window", dom.window],
  ["document", dom.window.document],
  ["navigator", dom.window.navigator],
]) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const SH2 = await import("../src/index.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > 30_000) throw new Error(`timed out waiting for ${label}`);
    await sleep(0);
  }
}
async function drain() {
  for (let i = 0; i < 5; i++) await sleep(0);
}
function percentile(values, fraction) {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function makeStore(size) {
  if (contender === "sh2") {
    const cells = [];
    for (let i = 0; i < size; i++) cells.push(SH2.atom(0));
    return {
      use(i) {
        return SH2.useValue(cells[i]);
      },
      write(i, value) {
        SH2.set(cells[i], value);
      },
      transition(value) {
        SH2.startTransitionWrite(() => {
          for (let i = 0; i < size; i++) SH2.set(cells[i], value);
        });
      },
      dispose() {
        for (const cell of cells) SH2.disposeCell(cell);
      },
    };
  }

  const values = new Int32Array(size);
  const listeners = [];
  for (let i = 0; i < size; i++) listeners.push(new Set());
  return {
    use(i) {
      return React.useSyncExternalStore(
        React.useCallback((listener) => {
          listeners[i].add(listener);
          return () => listeners[i].delete(listener);
        }, [i]),
        React.useCallback(() => values[i], [i]),
      );
    },
    write(i, value) {
      values[i] = value;
      for (const listener of listeners[i]) listener();
    },
    transition(value) {
      React.startTransition(() => {
        for (let i = 0; i < size; i++) {
          values[i] = value;
          for (const listener of listeners[i]) listener();
        }
      });
    },
    dispose() {},
  };
}

function mount(store, size, extra) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const Cell = React.memo(function Cell({ i }) {
    return React.createElement("span", { id: `c${i}` }, store.use(i));
  });
  const children = [];
  if (extra !== undefined) children.push(extra);
  for (let i = 0; i < size; i++) children.push(React.createElement(Cell, { i, key: i }));
  const root = createRoot(container);
  root.render(React.createElement("div", null, children));
  return { root, container };
}

async function unmount(tree, store) {
  tree.root.unmount();
  tree.container.remove();
  store.dispose();
  await drain();
}

let ms;
let stat;
if (scenario === "fanout") {
  const store = makeStore(5000);
  const tree = mount(store, 5000);
  await until(() => document.getElementById("c4999")?.textContent === "0", "fanout mount");
  await drain();
  const times = [];
  let seed = 0x2f6e2b1;
  for (let write = 0; write < 200; write++) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    const index = seed % 5000;
    const value = write + 1;
    const started = performance.now();
    store.write(index, value);
    await until(
      () => document.getElementById(`c${index}`)?.textContent === String(value),
      `fanout write ${write}`,
    );
    times.push(performance.now() - started);
  }
  ms = percentile(times, 0.5);
  stat = "median";
  await unmount(tree, store);
} else if (scenario === "transition") {
  let urgent;
  function Urgent() {
    const [value, setValue] = React.useState(0);
    urgent = setValue;
    return React.createElement("output", { id: "urgent" }, value);
  }
  const store = makeStore(2000);
  const tree = mount(store, 2000, React.createElement(Urgent, { key: "urgent" }));
  await until(
    () =>
      document.getElementById("c1999")?.textContent === "0" &&
      document.getElementById("urgent")?.textContent === "0",
    "transition mount",
  );
  await drain();
  const times = [];
  store.transition(1);
  for (let update = 1; update <= 30; update++) {
    if (update > 1) await sleep(16);
    const started = performance.now();
    urgent(update);
    await until(
      () => document.getElementById("urgent")?.textContent === String(update),
      `urgent update ${update}`,
    );
    times.push(performance.now() - started);
  }
  await until(() => document.getElementById("c1999")?.textContent === "1", "transition commit");
  ms = percentile(times, 0.95);
  stat = "p95";
  await unmount(tree, store);
} else if (scenario === "mount") {
  const times = [];
  for (let root = 0; root < 5; root++) {
    const store = makeStore(5000);
    const started = performance.now();
    const tree = mount(store, 5000);
    await until(() => document.getElementById("c4999")?.textContent === "0", `mount ${root}`);
    times.push(performance.now() - started);
    await unmount(tree, store);
  }
  ms = percentile(times, 0.5);
  stat = "median";
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

console.log(`${scenario},${contender},${stat},${ms.toFixed(2)}`);
