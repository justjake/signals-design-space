/**
 * One benchmark scenario in one process: jsdom + the real scheduler (no act),
 * a real createRoot from the linked fork build. Prints CSV rows
 * `scenario,contender,stat,ms` on stdout; commentary goes to stderr.
 *
 * Contenders:
 * - royale-fx1: this package's bindings (engine atoms + useValue).
 * - uses-baseline: a plain per-cell store read through useSyncExternalStore —
 *   the way standalone signal libraries usually meet React. Leak note: both
 *   contenders unmount their roots; the baseline store and the engine atoms
 *   are then unreachable (no registries hold them).
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "MutationObserver",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
] as const) {
  Object.defineProperty(g, key, {
    value: dom.window[key as "document"],
    configurable: true,
    writable: true,
  });
}

const [, , scenario, contenderName] = process.argv;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
}
const tick = (ms = 0) => new Promise<void>((res) => setTimeout(res, ms));

/** Resolve when the node's subtree next mutates. */
function nextMutation(el: Element): Promise<number> {
  return new Promise((res) => {
    const mo = new (g.MutationObserver as typeof MutationObserver)(() => {
      mo.disconnect();
      res(performance.now());
    });
    mo.observe(el, { childList: true, characterData: true, subtree: true });
  });
}

async function main(): Promise<void> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");

  interface Store {
    useCell(i: number): number;
    write(i: number, v: number): void;
    writeManyInTransition(updates: Array<[number, number]>): void;
  }

  let makeStore: (n: number) => Store;
  if (contenderName === "royale-fx1") {
    const { atom } = await import("signals-royale-fx1");
    const { register, startTransitionWrite } = await import("../src/runtime");
    const { useValue } = await import("../src/hooks");
    register();
    makeStore = (n) => {
      const cells = Array.from({ length: n }, () => atom(0));
      return {
        useCell: (i) => useValue(cells[i]!),
        write: (i, v) => cells[i]!.set(v),
        writeManyInTransition: (updates) => {
          startTransitionWrite(() => {
            for (const [i, v] of updates) cells[i]!.set(v);
          });
        },
      };
    };
  } else {
    // The ~35-line stock baseline: per-cell listeners + useSyncExternalStore.
    makeStore = (n) => {
      const values = new Array<number>(n).fill(0);
      const listeners: Array<Set<() => void>> = Array.from({ length: n }, () => new Set());
      const notify = (i: number) => {
        for (const l of listeners[i]!) l();
      };
      return {
        useCell: (i) =>
          React.useSyncExternalStore(
            (cb) => {
              listeners[i]!.add(cb);
              return () => listeners[i]!.delete(cb);
            },
            () => values[i]!,
          ),
        write: (i, v) => {
          values[i] = v;
          notify(i);
        },
        writeManyInTransition: (updates) => {
          React.startTransition(() => {
            for (const [i, v] of updates) {
              values[i] = v;
              notify(i);
            }
          });
        },
      };
    };
  }

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);

  function CellView({ store, i }: { store: Store; i: number }) {
    return React.createElement("span", null, String(store.useCell(i)));
  }
  /** A cell with a small render cost, so bulk re-renders span whole frames
   * and scheduling differences become visible. */
  function BurnCellView({ store, i }: { store: Store; i: number }) {
    const v = store.useCell(i);
    const end = performance.now() + 0.05;
    while (performance.now() < end) {
      // burn
    }
    return React.createElement("span", null, String(v));
  }
  const BurnGrid = React.memo(function BurnGrid({ store, n }: { store: Store; n: number }) {
    // Memoized: the urgent input above never re-renders the grid; only store
    // deliveries do.
    const kids = [];
    for (let i = 0; i < n; i++) kids.push(React.createElement(BurnCellView, { store, i, key: i }));
    return React.createElement("div", null, kids);
  });
  function Grid({ store, n }: { store: Store; n: number }) {
    const kids = [];
    for (let i = 0; i < n; i++) kids.push(React.createElement(CellView, { store, i, key: i }));
    return React.createElement("div", null, kids);
  }

  async function mountGrid(store: Store, n: number) {
    const root = createRoot(container);
    const settled = nextMutation(container);
    root.render(React.createElement(Grid, { store, n }));
    await settled;
    await tick(10);
    return root;
  }

  if (scenario === "fanout") {
    const N = 5000;
    const store = makeStore(N);
    const root = await mountGrid(store, N);
    const times: number[] = [];
    for (let w = 0; w < 200; w++) {
      const i = (w * 37) % N;
      const done = nextMutation(container);
      const t0 = performance.now();
      store.write(i, w + 1);
      times.push((await done) - t0);
    }
    console.log(`fanout,${contenderName},median-write-to-commit,${median(times).toFixed(3)}`);
    root.unmount();
  } else if (scenario === "transition") {
    const N = 2000;
    const store = makeStore(N);
    function App() {
      const [typed, setTyped] = React.useState(0);
      (g as { __setTyped?: (n: number) => void }).__setTyped = setTyped;
      return React.createElement(
        "div",
        null,
        React.createElement("b", { id: "typed" }, String(typed)),
        React.createElement(BurnGrid, { store, n: N }),
      );
    }
    const root = createRoot(container);
    const settled = nextMutation(container);
    root.render(React.createElement(App));
    await settled;
    await tick(10);
    const input = container.querySelector("b")!;
    const updates: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) updates.push([i, i + 1]);
    // Latency counts from each update's INTENDED cadence time: a store whose
    // "transition" degrades to one synchronous render freezes the queue, and
    // that freeze must show up in the urgent numbers.
    const start = performance.now();
    store.writeManyInTransition(updates);
    const urgentTimes: number[] = [];
    for (let k = 1; k <= 30; k++) {
      const intended = start + k * 16;
      while (performance.now() < intended) await tick(1);
      const done = nextMutation(input);
      // Discrete-equivalent dispatch: user input arrives at discrete
      // priority, which is what preempts an in-flight transition.
      flushSync(() => {
        (g as { __setTyped?: (n: number) => void }).__setTyped!(k);
      });
      urgentTimes.push((await done) - intended);
    }
    console.error("# samples: " + urgentTimes.map((t) => t.toFixed(1)).join(" "));
    console.log(`transition,${contenderName},p95-urgent-to-commit,${p95(urgentTimes).toFixed(3)}`);
    const deadline = Date.now() + 30000;
    while (!container.textContent!.includes(String(N)) && Date.now() < deadline) await tick(10);
    console.error(`# transition completed for ${contenderName}`);
    root.unmount();
  } else if (scenario === "mount") {
    const N = 5000;
    const times: number[] = [];
    for (let r = 0; r < 5; r++) {
      const store = makeStore(N);
      const freshContainer = dom.window.document.createElement("div");
      dom.window.document.body.appendChild(freshContainer);
      const root = createRoot(freshContainer);
      const settled = nextMutation(freshContainer);
      const t0 = performance.now();
      root.render(React.createElement(Grid, { store, n: N }));
      times.push((await settled) - t0);
      await tick(10);
      root.unmount();
      freshContainer.remove();
    }
    console.log(`mount,${contenderName},median-mount,${median(times).toFixed(3)}`);
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
  await tick(20);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
