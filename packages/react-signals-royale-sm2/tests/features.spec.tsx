// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import adapter from "../royale/adapter";
import { getRuntime, useAtom } from "../src/index";

const { React } = adapter;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Array<{ render(node: React.ReactNode): void; unmount(): void }> = [];
let containers: HTMLElement[] = [];

beforeEach(() => {
  adapter.resetForTest();
  roots = [];
  containers = [];
});

afterEach(async () => {
  await adapter.act(async () => {
    for (const root of roots) root.unmount();
  });
  for (const container of containers) container.remove();
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = adapter.ReactDOMClient.createRoot(container);
  roots.push(root);
  containers.push(container);
  await adapter.act(async () => root.render(node));
  return container;
}

function deferred<T>(): [Promise<T>, (value: T) => void] {
  let resolve!: (value: T) => void;
  return [new Promise<T>((done) => (resolve = done)), resolve];
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

it("suspends once, serves stale during refresh, and converges in its transition", async () => {
  let [request, resolve] = deferred<string>();
  let evaluations = 0;
  const remote = adapter.computed((use) => {
    ++evaluations;
    return use(request);
  });
  function View(): React.ReactNode {
    const value = adapter.useValue(remote);
    const pending = adapter.useIsPending(remote);
    return (
      <span>
        {value}:{pending ? "pending" : "ready"}
      </span>
    );
  }
  const container = await mount(
    <React.Suspense fallback={<i>loading</i>}>
      <View />
    </React.Suspense>,
  );
  expect(container.textContent).toBe("loading");
  await adapter.act(async () => {
    resolve("first");
    await tick();
  });
  expect(container.textContent).toBe("first:ready");

  [request, resolve] = deferred<string>();
  await adapter.act(async () => adapter.refresh(remote));
  expect(container.textContent).toBe("first:pending");
  expect(container.textContent).not.toContain("loading");
  await adapter.act(async () => {
    resolve("second");
    await tick();
  });
  expect(container.textContent).toBe("second:ready");

  [request, resolve] = deferred<string>();
  await adapter.act(async () => {
    adapter.startTransitionWrite(() => adapter.refresh(remote));
  });
  expect(container.textContent).toBe("second:pending");
  await adapter.act(async () => {
    resolve("third");
    await tick();
  });
  expect(container.textContent).toBe("third:ready");
  expect(evaluations).toBeLessThan(30);
});

it("reports causal chains from component renders to writes", async () => {
  const value = adapter.atom(0);
  function View(): React.ReactNode {
    return <span>{adapter.useValue(value)}</span>;
  }
  const container = await mount(<View />);
  const trace = adapter.trace();
  await adapter.act(async () => adapter.set(value, 1));
  expect(container.textContent).toBe("1");
  const urgent = trace.whyLastDelivery(value);
  expect(urgent[0]).toContain("component-render");
  expect(urgent.some((line) => line.startsWith("write#"))).toBe(true);
  await adapter.act(async () => {
    adapter.startTransitionWrite(() => adapter.set(value, 2));
  });
  expect(container.textContent).toBe("2");
  const transition = trace.whyLastDelivery(value);
  expect(transition.some((line) => line.startsWith("write#"))).toBe(true);
  expect(trace.events().some((event) => event.kind === "batch-retire")).toBe(true);
  trace.stop();
});

it("runs lazy initializers at first render and before set-before-read", async () => {
  let calls = 0;
  const value = adapter.atom(() => {
    ++calls;
    return 1;
  });
  expect(calls).toBe(0);
  function View(): React.ReactNode {
    return <span>{adapter.useValue(value)}</span>;
  }
  const container = await mount(<View />);
  expect(container.textContent).toBe("1");
  expect(calls).toBe(1);
  const second = adapter.atom(() => {
    ++calls;
    return 2;
  });
  adapter.set(second, 3);
  expect(calls).toBe(2);
  expect(adapter.read(second)).toBe(3);
});

it("hydrates installed state without a corrective render", async () => {
  const server = adapter.atom(7, { label: "count" });
  const json = adapter.serialize([server]);
  adapter.resetForTest();
  let initialized = 0;
  const client = adapter.atom(
    () => {
      ++initialized;
      return 0;
    },
    { label: "count" },
  );
  adapter.initialize(json, [client]);
  let renders = 0;
  function View(): React.ReactNode {
    ++renders;
    return <span>{adapter.useValue(client)}</span>;
  }
  const container = await mount(<View />);
  expect(container.textContent).toBe("7");
  expect(initialized).toBe(0);
  expect(renders).toBe(1);
});

it("supports component-owned atoms, computed hooks, committed reads, and committed effects", async () => {
  const shared = adapter.atom(1);
  const effects: number[] = [];
  let local!: ReturnType<typeof useAtom<number>>;
  function View(): React.ReactNode {
    local = useAtom(2);
    const sharedValue = adapter.useValue(shared) as number;
    const doubled = adapter.useComputed(() => local.get() * 2, [local]);
    const committed = adapter.useCommitted(shared);
    adapter.useSignalEffect(() => {
      effects.push(shared.get());
    });
    return (
      <span>
        {sharedValue}:{committed}:{doubled}
      </span>
    );
  }
  const container = await mount(<View />);
  expect(container.textContent).toBe("1:1:4");
  await adapter.act(async () => {
    adapter.set(shared, 2);
    local.set(3);
  });
  expect(container.textContent).toBe("2:2:6");
  expect(effects).toContain(2);
  await adapter.act(async () => roots[0].unmount());
  roots.length = 0;
  expect(shared.subscribers.size).toBe(0);
  expect(getRuntime().liveBatchCount()).toBe(0);
});
