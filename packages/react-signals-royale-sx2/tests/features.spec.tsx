import { afterEach, expect, test, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  atom,
  computed,
  initializeAtomState,
  isPending,
  liveBatchIds,
  refresh,
  serializeAtomState,
  trace,
  useThenable,
} from "signals-royale-sx2";
import {
  register,
  startTransitionWrite,
  useIsPending,
  useValue,
  write,
  type RegistrationHandle,
} from "../src/index";

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
let handle: RegistrationHandle | undefined;

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  roots.length = 0;
  for (const container of containers) container.remove();
  containers.length = 0;
  handle?.dispose();
  handle = undefined;
});

async function mount(node: React.ReactNode) {
  if (handle === undefined) handle = register();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  containers.push(container);
  roots.push(root);
  await act(async () => root.render(node));
  return { container, root };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve, settled: false };
}

test("mount mid-transition reads committed state then joins that transition", async () => {
  const value = atom(0);
  const gate = deferred<void>();
  function Reader({ id }: { id: string }) {
    return (
      <span>
        {id}:{useValue(value)};
      </span>
    );
  }
  function App({ extra }: { extra: boolean }) {
    const current = useValue(value);
    if (current === 1 && !gate.settled) throw gate.promise;
    return (
      <>
        {<Reader id="one" />}
        {extra && <Reader id="two" />}
      </>
    );
  }
  const { container, root } = await mount(
    <React.Suspense fallback={null}>
      <App extra={false} />
    </React.Suspense>,
  );
  await act(async () => startTransitionWrite(() => write(value, 1)));
  expect(container.textContent).toBe("one:0;");
  await act(async () =>
    root.render(
      <React.Suspense fallback={null}>
        <App extra />
      </React.Suspense>,
    ),
  );
  expect(container.textContent).toBe("one:0;two:0;");
  gate.settled = true;
  await act(async () => gate.resolve());
  expect(container.textContent).toBe("one:1;two:1;");
});

test("StrictMode nets one lifetime observation and unmount cleans it", async () => {
  const events: string[] = [];
  const value = atom(1, {
    effect: () => {
      events.push("start");
      return () => events.push("stop");
    },
  });
  function App() {
    return <span>{useValue(value)}</span>;
  }
  const { root } = await mount(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  await Promise.resolve();
  expect(events).toEqual(["start"]);
  await act(async () => root.unmount());
  roots.length = 0;
  await Promise.resolve();
  expect(events).toEqual(["start", "stop"]);
});

test("one transition stays consistent across two roots", async () => {
  const value = atom(0);
  function App() {
    return <span>{useValue(value)}</span>;
  }
  const one = await mount(<App />);
  const two = await mount(<App />);
  await act(async () => startTransitionWrite(() => write(value, 7)));
  expect(one.container.textContent).toBe("7");
  expect(two.container.textContent).toBe("7");
  expect(value.get()).toBe(7);
});

test("store-only transitions retire and unmounted readers receive nothing", async () => {
  const shown = atom(0);
  const orphan = atom(0);
  let renders = 0;
  function App() {
    renders++;
    return <span>{useValue(shown)}</span>;
  }
  const { root } = await mount(<App />);
  await act(async () => startTransitionWrite(() => write(orphan, 5)));
  expect(orphan.get()).toBe(5);
  await act(async () => root.unmount());
  roots.length = 0;
  const before = renders;
  await act(async () => write(shown, 1));
  expect(renders).toBe(before);
});

test("a transition pruned by unmount rolls its draft back", async () => {
  const value = atom(0);
  function App() {
    return <span>{useValue(value)}</span>;
  }
  const { root } = await mount(<App />);
  await act(async () => {
    startTransitionWrite(() => write(value, 1));
    root.unmount();
  });
  roots.length = 0;
  expect(value.get()).toBe(0);
  expect(liveBatchIds()).toEqual([]);
});

test("write during render fails loudly", async () => {
  const value = atom(0);
  let failure: unknown;
  function Bad() {
    try {
      write(value, 1);
    } catch (error) {
      failure = error;
    }
    return <span>{useValue(value)}</span>;
  }
  const { container } = await mount(<Bad />);
  expect(String(failure)).toMatch(/during render/);
  expect(container.textContent).toBe("0");
});

test("first load suspends once and refresh serves stale", async () => {
  let request = deferred<number>();
  const fetches = vi.fn(() => request.promise);
  const resource = computed(() => useThenable(fetches()));
  function App() {
    const value = useValue(resource);
    const pending = useIsPending(resource);
    return (
      <span>
        {value}:{String(pending)}
      </span>
    );
  }
  const { container } = await mount(
    <React.Suspense fallback={<span>loading</span>}>
      <App />
    </React.Suspense>,
  );
  expect(container.textContent).toBe("loading");
  await act(async () => {
    request.resolve(1);
    await request.promise;
  });
  expect(container.textContent).toBe("1:false");
  expect(fetches).toHaveBeenCalledTimes(1);

  request = deferred<number>();
  await act(async () => refresh(resource));
  expect(container.textContent).toBe("1:true");
  expect(isPending(resource)).toBe(true);
  request.resolve(2);
  await act(async () => request.promise);
  expect(container.textContent).toBe("2:false");

  request = deferred<number>();
  await act(async () => startTransitionWrite(() => refresh(resource)));
  expect(container.textContent).toBe("2:true");
  await act(async () => {
    request.resolve(3);
    await request.promise;
    await Promise.resolve();
  });
  await act(async () => {});
  expect(container.textContent).toBe("3:false");
  expect(fetches).toHaveBeenCalledTimes(3);
});

test("causality, lazy initialization, and SSR installation", async () => {
  const initialize = vi.fn(() => 1);
  const value = atom(initialize, { key: "value" });
  expect(initialize).not.toHaveBeenCalled();
  const tracer = trace();
  function App() {
    return <span>{useValue(value)}</span>;
  }
  const { container } = await mount(<App />);
  expect(initialize).toHaveBeenCalledOnce();
  await act(async () => write(value, 2));
  expect(tracer.whyLastDelivery(value)).toEqual([
    "component delivery [batch 0]",
    "write [batch 0]",
  ]);
  const json = serializeAtomState([value]);
  const restored = atom(() => 99, { key: "value" });
  initializeAtomState(json, [restored]);
  expect(restored.get()).toBe(2);
  expect(container.textContent).toBe("2");
  let hydrationRenders = 0;
  function Restored() {
    hydrationRenders++;
    return <span>{useValue(restored)}</span>;
  }
  const hydrated = await mount(<Restored />);
  expect(hydrated.container.textContent).toBe("2");
  expect(hydrationRenders).toBe(1);
  tracer.stop();
});
