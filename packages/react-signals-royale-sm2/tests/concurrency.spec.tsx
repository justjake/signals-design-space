// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import adapter from "../royale/adapter";

const { React } = adapter;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Array<{ render(node: unknown): void; unmount(): void }> = [];
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

it("mounts an urgent subscriber on canonical state and joins the live transition", async () => {
  const value = adapter.atom("old");
  const gate = adapter.atom(false);
  const [promise, release] = deferred<string>();
  const remote = adapter.computed((use) => use(promise));
  let showLate!: () => void;
  function Reader({ late = false }: { late?: boolean }): React.ReactNode {
    const current = adapter.useValue(value);
    const blocked = adapter.useValue(gate);
    return (
      <span>
        {late ? "late=" : "early="}
        {current};{blocked ? <Block /> : null}
      </span>
    );
  }
  function Block(): React.ReactNode {
    adapter.useValue(remote);
    return null;
  }
  function App(): React.ReactNode {
    const [late, setLate] = React.useState(false);
    showLate = () => setLate(true);
    return (
      <React.Suspense fallback={<i>wait</i>}>
        <Reader />
        {late ? <Reader late /> : null}
      </React.Suspense>
    );
  }
  const container = await mount(<App />);
  adapter.startTransitionWrite(() => {
    adapter.set(value, "new");
    adapter.set(gate, true);
  });
  await adapter.act(async () => {});
  expect(container.textContent).toBe("early=old;");
  await adapter.act(async () => showLate());
  expect(container.textContent).toBe("early=old;late=old;");
  await adapter.act(async () => {
    release("ready");
    await tick();
  });
  expect(container.textContent).toBe("early=new;late=new;");
});

it("flushSync excludes deferred work", async () => {
  const slow = adapter.atom(0);
  const urgent = adapter.atom(0);
  const gate = adapter.atom(false);
  const [promise, release] = deferred<number>();
  const remote = adapter.computed((use) => use(promise));
  function View(): React.ReactNode {
    const slowValue = adapter.useValue(slow);
    const urgentValue = adapter.useValue(urgent);
    const blocked = adapter.useValue(gate);
    return (
      <span>
        {slowValue}:{urgentValue}
        {blocked ? <Block /> : null}
      </span>
    );
  }
  function Block(): React.ReactNode {
    adapter.useValue(remote);
    return null;
  }
  const container = await mount(
    <React.Suspense fallback={<i>wait</i>}>
      <View />
    </React.Suspense>,
  );
  await adapter.act(async () => {
    adapter.startTransitionWrite(() => {
      adapter.set(slow, 1);
      adapter.set(gate, true);
    });
    adapter.flushSync(() => adapter.set(urgent, 1));
  });
  expect(container.textContent).toBe("0:1");
  await adapter.act(async () => {
    release(1);
    await tick();
  });
  expect(container.textContent).toBe("1:1");
});

it("keeps sibling readers and two roots on whole worlds", async () => {
  const left = adapter.atom("a");
  const right = adapter.atom("a");
  const frames: string[] = [];
  function View(): React.ReactNode {
    const frame = `${adapter.useValue(left)}${adapter.useValue(right)}`;
    frames.push(frame);
    return <span>{frame}</span>;
  }
  const first = await mount(<View />);
  const second = await mount(<View />);
  await adapter.act(async () => {
    adapter.startTransitionWrite(() => {
      adapter.set(left, "b");
      adapter.set(right, "b");
    });
  });
  expect(first.textContent).toBe("bb");
  expect(second.textContent).toBe("bb");
  for (const frame of frames) expect(["aa", "bb"]).toContain(frame);
});

it("does not deliver after unmount", async () => {
  const value = adapter.atom(0);
  let renders = 0;
  function View(): React.ReactNode {
    ++renders;
    return <span>{adapter.useValue(value)}</span>;
  }
  await mount(<View />);
  const before = renders;
  await adapter.act(async () => roots[0].unmount());
  roots.length = 0;
  adapter.set(value, 1);
  expect(renders).toBe(before);
  expect(value.subscribers.size).toBe(0);
});

it("fails loudly on a write during render", async () => {
  const value = adapter.atom(0);
  function Bad(): React.ReactNode {
    adapter.set(value, 1);
    return null;
  }
  await expect(mount(<Bad />)).rejects.toThrow("during render");
  roots.length = 0;
});

it("preserves branch arithmetic: urgent double is 2 now and 6 after retirement", async () => {
  const count = adapter.atom(1);
  const gate = adapter.atom(false);
  const [promise, release] = deferred<number>();
  const remote = adapter.computed((use) => use(promise));
  function View(): React.ReactNode {
    const value = adapter.useValue(count);
    const blocked = adapter.useValue(gate);
    return (
      <span>
        {value}
        {blocked ? <Block /> : null}
      </span>
    );
  }
  function Block(): React.ReactNode {
    adapter.useValue(remote);
    return null;
  }
  const container = await mount(
    <React.Suspense fallback={<i>wait</i>}>
      <View />
    </React.Suspense>,
  );
  await adapter.act(async () => {
    adapter.startTransitionWrite(() => {
      adapter.update(count, (value) => (value as number) + 2);
      adapter.set(gate, true);
    });
    adapter.update(count, (value) => (value as number) * 2);
  });
  expect(container.textContent).toBe("2");
  await adapter.act(async () => {
    release(0);
    await tick();
  });
  expect(container.textContent).toBe("6");
});
