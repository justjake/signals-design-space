// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import adapter from "../royale/adapter";

const { React } = adapter;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Array<{ unmount(): void }> = [];
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

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("real React bridge", () => {
  it("coalesces urgent batches into one committed render", async () => {
    const a = adapter.atom(0);
    const b = adapter.atom(0);
    let commits = 0;
    function View(): React.ReactNode {
      const value = `${adapter.useValue(a)}:${adapter.useValue(b)}`;
      React.useLayoutEffect(() => {
        ++commits;
      });
      return <span>{value}</span>;
    }
    const container = await mount(<View />);
    expect(container.textContent).toBe("0:0");
    commits = 0;
    await adapter.act(async () => {
      adapter.batch(() => {
        adapter.set(a, 1);
        adapter.set(b, 2);
      });
    });
    expect(container.textContent).toBe("1:2");
    expect(commits).toBe(1);
  });

  it("keeps a suspended transition hidden and rebases an urgent update", async () => {
    const count = adapter.atom(1);
    const show = adapter.atom(false);
    let release!: (value: string) => void;
    const promise = new Promise<string>((resolve) => {
      release = resolve;
    });
    const remote = adapter.computed((use) => use(promise));

    function View(): React.ReactNode {
      const value = adapter.useValue(count);
      const visible = adapter.useValue(show);
      const pending = adapter.useIsPending(count);
      return (
        <span>
          {value}:{pending ? "pending" : "ready"}
          {visible ? <Remote /> : null}
        </span>
      );
    }
    function Remote(): React.ReactNode {
      return <b>{adapter.useValue(remote)}</b>;
    }

    const container = await mount(
      <React.Suspense fallback={<i>fallback</i>}>
        <View />
      </React.Suspense>,
    );
    expect(container.textContent).toBe("1:ready");

    await adapter.act(async () => {
      adapter.startTransitionWrite(() => {
        adapter.update(count, (value) => (value as number) + 1);
        adapter.set(show, true);
      });
    });
    expect(container.textContent).toBe("1:pending");

    await adapter.act(async () => {
      adapter.update(count, (value) => (value as number) * 2);
    });
    expect(container.textContent).toBe("2:pending");

    await adapter.act(async () => {
      release("done");
      await tick();
    });
    expect(container.textContent).toBe("4:readydone");
  });

  it("coalesces StrictMode observation flaps and cleans up after unmount", async () => {
    const lifecycle: string[] = [];
    const value = adapter.atom(1, {
      onObserved() {
        lifecycle.push("start");
        return () => lifecycle.push("stop");
      },
    });
    function View(): React.ReactNode {
      return <span>{adapter.useValue(value)}</span>;
    }
    await mount(
      <React.StrictMode>
        <View />
      </React.StrictMode>,
    );
    await tick();
    expect(lifecycle).toEqual(["start"]);
    await adapter.act(async () => roots[0].unmount());
    await tick();
    expect(lifecycle).toEqual(["start", "stop"]);
    roots.length = 0;
  });

  it("brackets React DOM writes so an observer only sees third-party writes", async () => {
    const value = adapter.atom("a");
    function View(): React.ReactNode {
      return <span>{adapter.useValue(value)}</span>;
    }
    const container = await mount(<View />);
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    const phases: string[] = [];
    const unsubscribe = adapter.onDomMutation((phase, root) => {
      if (root !== container) return;
      phases.push(phase);
      if (phase === "start") observer.disconnect();
      else observer.observe(container, { childList: true, subtree: true, characterData: true });
    });
    await adapter.act(async () => adapter.set(value, "b"));
    await tick();
    expect(container.textContent).toBe("b");
    expect(phases).toEqual(["start", "stop"]);
    expect(mutations).toHaveLength(0);
    container.append(document.createElement("em"));
    await tick();
    expect(mutations).toHaveLength(1);
    unsubscribe();
    observer.disconnect();
  });
});
