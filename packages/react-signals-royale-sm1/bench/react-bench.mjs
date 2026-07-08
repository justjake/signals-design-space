import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const childAt = process.argv.indexOf("--child");

if (childAt === -1) {
  console.log("scenario,contender,stat,ms");
  for (const scenario of ["fanout", "transition", "mount"]) {
    for (const contender of ["sm1", "useSyncExternalStore"]) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--child", scenario, contender],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      if (result.status !== 0) {
        throw new Error(`${scenario}/${contender} exited with ${result.status ?? result.signal}`);
      }
      process.stdout.write(result.stdout);
    }
  }
} else {
  await runChild(process.argv[childAt + 1], process.argv[childAt + 2]);
}

async function runChild(scenario, contender) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const bindings = await import("../src/index.ts");
  const registration = contender === "sm1" ? bindings.register() : null;
  let cellRenders = 0;

  function createCells(count) {
    if (contender === "sm1") {
      const cells = [];
      for (let i = 0; i < count; i++) cells.push(bindings.atom(0));
      return {
        useCell(index) {
          return bindings.useValue(cells[index]);
        },
        writeCell(index, value) {
          cells[index].set(value);
        },
        writeAllInTransition(value) {
          bindings.startTransitionWrite(() => {
            for (const cell of cells) cell.set(value);
          });
        },
      };
    }

    const cells = [];
    for (let i = 0; i < count; i++) {
      const listeners = new Set();
      const cell = {
        value: 0,
        get: () => cell.value,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set(value) {
          if (Object.is(cell.value, value)) return;
          cell.value = value;
          for (const listener of listeners) listener();
        },
      };
      cells.push(cell);
    }
    return {
      useCell(index) {
        const cell = cells[index];
        return React.useSyncExternalStore(cell.subscribe, cell.get, cell.get);
      },
      writeCell(index, value) {
        cells[index].set(value);
      },
      writeAllInTransition(value) {
        React.startTransition(() => {
          for (const cell of cells) cell.set(value);
        });
      },
    };
  }

  function renderCells(store, count, extra) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const Cell = React.memo(function Cell({ index }) {
      cellRenders++;
      return React.createElement("span", { id: `c${index}` }, store.useCell(index));
    });
    function App() {
      const children = [];
      if (extra !== undefined) children.push(React.cloneElement(extra, { key: "extra" }));
      for (let i = 0; i < count; i++) {
        children.push(React.createElement(Cell, { index: i, key: i }));
      }
      return React.createElement("div", null, children);
    }
    const root = createRoot(container);
    root.render(React.createElement(App));
    return {
      readCell(index) {
        return document.getElementById(`c${index}`)?.textContent ?? null;
      },
      async unmount() {
        root.unmount();
        container.remove();
        await drain();
      },
    };
  }

  if (scenario === "fanout") {
    const count = 5000;
    const store = createCells(count);
    const tree = renderCells(store, count);
    await until(() => tree.readCell(count - 1) === "0", "fanout mount");
    await drain();
    const times = [];
    let seed = 0x2f6e2b1;
    for (let write = 0; write < 200; write++) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      const index = seed % count;
      const value = write + 1;
      const start = performance.now();
      store.writeCell(index, value);
      await until(() => tree.readCell(index) === String(value), `fanout write ${write}`);
      times.push(performance.now() - start);
    }
    console.log(`fanout,${contender},median_write_to_commit_ms,${median(times).toFixed(2)}`);
    await tree.unmount();
  } else if (scenario === "transition") {
    const count = 2000;
    const store = createCells(count);
    let setUrgent = null;
    function Urgent() {
      const [value, setValue] = React.useState(0);
      React.useEffect(() => {
        setUrgent = setValue;
        return () => {
          setUrgent = null;
        };
      }, []);
      return React.createElement("output", { id: "urgent" }, value);
    }
    const tree = renderCells(store, count, React.createElement(Urgent));
    const readUrgent = () => document.getElementById("urgent")?.textContent ?? null;
    await until(
      () => tree.readCell(count - 1) === "0" && readUrgent() === "0" && setUrgent !== null,
      "transition mount",
    );
    await drain();
    const latencies = [];
    store.writeAllInTransition(1);
    for (let update = 1; update <= 30; update++) {
      if (update > 1) await sleep(16);
      const start = performance.now();
      setUrgent(update);
      await until(() => readUrgent() === String(update), `urgent update ${update}`);
      latencies.push(performance.now() - start);
    }
    await until(
      () => tree.readCell(0) === "1" && tree.readCell(count - 1) === "1",
      "transition completion",
    );
    console.log(`transition,${contender},p95_urgent_commit_ms,${p95(latencies).toFixed(2)}`);
    await tree.unmount();
  } else if (scenario === "mount") {
    const times = [];
    for (let root = 0; root < 5; root++) {
      const store = createCells(5000);
      const start = performance.now();
      const tree = renderCells(store, 5000);
      await until(() => tree.readCell(4999) === "0", `mount root ${root}`);
      times.push(performance.now() - start);
      await tree.unmount();
    }
    console.log(`mount,${contender},median_first_commit_ms,${median(times).toFixed(2)}`);
  } else {
    throw new Error(`Unknown scenario ${scenario}`);
  }

  registration?.dispose();
  dom.window.close();
  void cellRenders;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain() {
  for (let i = 0; i < 5; i++) await sleep(0);
}

async function until(predicate, label) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 60_000) throw new Error(`Timed out waiting for ${label}`);
    await sleep(0);
  }
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length & 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function p95(values) {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)];
}
