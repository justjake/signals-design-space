/** @vitest-environment jsdom */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import adapter from "../royale/adapter";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: ReturnType<typeof adapter.ReactDOMClient.createRoot>;

beforeEach(() => {
  adapter.resetForTest();
  adapter.register();
  container = document.createElement("div");
  document.body.append(container);
  root = adapter.ReactDOMClient.createRoot(container);
});

afterEach(async () => {
  await adapter.act(() => root.unmount());
  container.remove();
});

describe("real React protocol", () => {
  test("urgent, batch, and transition writes commit coherent values", async () => {
    const left = adapter.atom(1, { label: "left" });
    const right = adapter.atom(10, { label: "right" });
    const commits: string[] = [];
    function View() {
      const value = `${adapter.useValue(left)}:${adapter.useValue(right)}`;
      React.useLayoutEffect(() => {
        commits.push(value);
      });
      return <div>{value}</div>;
    }
    await adapter.act(() => root.render(<View />));
    await adapter.act(() => adapter.set(left, 2));
    expect(container.textContent).toBe("2:10");
    const beforeBatch = commits.length;
    await adapter.act(() =>
      adapter.batch(() => {
        adapter.set(left, 3);
        adapter.set(right, 30);
      }),
    );
    expect(container.textContent).toBe("3:30");
    expect(commits.length).toBe(beforeBatch + 1);
    await adapter.act(() =>
      adapter.startTransitionWrite(() => adapter.update(left, (value) => (value as number) * 2)),
    );
    expect(container.textContent).toBe("6:30");
  });

  test("StrictMode nets one lifetime observation and unmount cleans it", async () => {
    let starts = 0;
    let stops = 0;
    const value = adapter.atom(1, {
      onObserved: () => {
        starts++;
        return () => {
          stops++;
        };
      },
    });
    function View() {
      return <div>{adapter.useValue(value) as number}</div>;
    }
    await adapter.act(() =>
      root.render(
        <React.StrictMode>
          <View />
        </React.StrictMode>,
      ),
    );
    await Promise.resolve();
    expect(starts).toBe(1);
    await adapter.act(() => root.render(null));
    await Promise.resolve();
    expect(stops).toBe(1);
  });

  test("suspended transition stays hidden, urgent work commits, then functional updates rebase", async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const count = adapter.atom(1);
    const query = adapter.atom(0);
    const data = adapter.computed((use) => (adapter.read(query) === 0 ? "ready" : use(pending)));
    function View() {
      const value = adapter.useValue(count);
      const result = adapter.useValue(data);
      const loading = adapter.useIsPending(data);
      return (
        <div>
          {String(value)}:{String(result)}:{String(loading)}
        </div>
      );
    }
    await adapter.act(() =>
      root.render(
        <React.Suspense fallback={<div>fallback</div>}>
          <View />
        </React.Suspense>,
      ),
    );
    expect(container.textContent).toBe("1:ready:false");
    await adapter.act(() =>
      adapter.startTransitionWrite(() => {
        adapter.update(count, (value) => (value as number) * 2);
        adapter.set(query, 1);
      }),
    );
    expect(container.textContent).toBe("1:ready:true");
    await adapter.act(() =>
      adapter.flushSync(() => adapter.update(count, (value) => (value as number) + 1)),
    );
    expect(container.textContent).toBe("2:ready:true");
    await adapter.act(async () => {
      resolve("loaded");
      await pending;
    });
    expect(container.textContent).toBe("4:loaded:false");
  });

  test("one transaction commits coherently across two roots", async () => {
    const otherContainer = document.createElement("div");
    document.body.append(otherContainer);
    const otherRoot = adapter.ReactDOMClient.createRoot(otherContainer);
    const value = adapter.atom(1);
    function View() {
      return <div>{adapter.useValue(value) as number}</div>;
    }
    await adapter.act(() => {
      root.render(<View />);
      otherRoot.render(<View />);
    });
    await adapter.act(() =>
      adapter.startTransitionWrite(() =>
        adapter.update(value, (current) => (current as number) + 1),
      ),
    );
    expect(container.textContent).toBe("2");
    expect(otherContainer.textContent).toBe("2");
    expect(adapter.committed(value, container)).toBe(2);
    expect(adapter.committed(value, otherContainer)).toBe(2);
    await adapter.act(() => otherRoot.unmount());
    otherContainer.remove();
  });

  test("a subscriber mounted during a suspended transition joins its eventual commit", async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const count = adapter.atom(1);
    const query = adapter.atom(0);
    const data = adapter.computed((use) => (adapter.read(query) === 0 ? "ready" : use(pending)));
    function View({ name }: { name: string }) {
      return (
        <div>
          {name}:{String(adapter.useValue(count))}:{String(adapter.useValue(data))}
        </div>
      );
    }
    await adapter.act(() =>
      root.render(
        <React.Suspense fallback="fallback">
          <View name="old" />
        </React.Suspense>,
      ),
    );
    await adapter.act(() =>
      adapter.startTransitionWrite(() => {
        adapter.update(count, (value) => (value as number) + 1);
        adapter.set(query, 1);
      }),
    );
    await adapter.act(() =>
      root.render(
        <React.Suspense fallback="fallback">
          <View name="old" />
          <View name="late" />
        </React.Suspense>,
      ),
    );
    expect(container.textContent).toBe("old:1:readylate:1:ready");
    await adapter.act(async () => {
      resolve("loaded");
      await pending;
    });
    expect(container.textContent).toBe("old:2:loadedlate:2:loaded");
  });

  test("branch arithmetic is urgent 2 now and rebased 6 after retirement", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const counter = adapter.atom(1);
    const branch = adapter.atom(false);
    const gate = adapter.computed((use) => (adapter.read(branch) ? use(pending) : undefined));
    function View() {
      adapter.useValue(gate);
      return <div>{String(adapter.useValue(counter))}</div>;
    }
    await adapter.act(() =>
      root.render(
        <React.Suspense fallback="fallback">
          <View />
        </React.Suspense>,
      ),
    );
    await adapter.act(() =>
      adapter.startTransitionWrite(() => {
        adapter.update(counter, (value) => (value as number) * 3);
        adapter.set(branch, true);
      }),
    );
    await adapter.act(() => adapter.update(counter, (value) => (value as number) * 2));
    expect(container.textContent).toBe("2");
    await adapter.act(async () => {
      resolve();
      await pending;
    });
    expect(container.textContent).toBe("6");
  });

  test("a component mounted by a transition can suspend without breaking that transition", async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const show = adapter.atom(false);
    const query = adapter.atom(0);
    const data = adapter.computed((use) => (adapter.read(query) === 0 ? "ready" : use(pending)));
    let lateAttempts = 0;
    function Late() {
      lateAttempts++;
      return <b>late:{String(adapter.useValue(data))}</b>;
    }
    function App() {
      return <div>old:{adapter.useValue(show) ? <Late /> : null}</div>;
    }
    await adapter.act(() =>
      root.render(
        <React.Suspense fallback="fallback">
          <App />
        </React.Suspense>,
      ),
    );
    await adapter.act(() =>
      adapter.startTransitionWrite(() => {
        adapter.set(show, true);
        adapter.set(query, 1);
      }),
    );
    expect(lateAttempts).toBeGreaterThan(0);
    expect(container.textContent).toBe("old:");
    await adapter.act(async () => {
      resolve("loaded");
      await pending;
    });
    expect(container.textContent).toBe("old:late:loaded");
  });

  test("unmounted subscribers receive no deliveries", async () => {
    const value = adapter.atom(0);
    let renders = 0;
    function View() {
      renders++;
      return <div>{adapter.useValue(value) as number}</div>;
    }
    await adapter.act(() => root.render(<View />));
    await adapter.act(() => root.render(null));
    const afterUnmount = renders;
    await adapter.act(() => adapter.set(value, 1));
    expect(renders).toBe(afterUnmount);
  });

  test("time slicing yields a large transition to an urgent input commit", async () => {
    const size = adapter.atom(0);
    const input = adapter.atom(0);
    let slowRenders = 0;
    let noteStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      noteStarted = resolve;
    });
    function Slow() {
      if (++slowRenders === 1) noteStarted();
      const end = performance.now() + 1;
      while (performance.now() < end) {}
      return <i />;
    }
    function View() {
      const count = adapter.useValue(size) as number;
      const typed = adapter.useValue(input) as number;
      const children: React.ReactNode[] = [];
      for (let index = 0; index < count; index++) children.push(<Slow key={index} />);
      return (
        <div>
          <span>
            {typed}:{count}
          </span>
          {children}
        </div>
      );
    }
    await adapter.act(() => root.render(<View />));
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
    adapter.startTransitionWrite(() => adapter.set(size, 80));
    await started;
    expect(slowRenders).toBeLessThan(80);
    adapter.flushSync(() => adapter.set(input, 1));
    expect(container.querySelector("span")?.textContent).toBe("1:0");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    expect(container.querySelector("span")?.textContent).toBe("1:80");
  }, 5_000);

  test("first-load Suspense converges once; refresh serves stale data without fallback", async () => {
    let resolve!: (value: string) => void;
    let request = new Promise<string>((done) => {
      resolve = done;
    });
    const data = adapter.computed((use) => use(request));
    function View() {
      const value = adapter.useValue(data);
      return (
        <div>
          {String(value)}:{String(adapter.useIsPending(data))}
        </div>
      );
    }
    await adapter.act(() =>
      root.render(
        <React.Suspense fallback={<div>fallback</div>}>
          <View />
        </React.Suspense>,
      ),
    );
    expect(container.textContent).toBe("fallback");
    await adapter.act(async () => {
      resolve("one");
      await request;
    });
    expect(container.textContent).toBe("one:false");
    request = new Promise<string>((done) => {
      resolve = done;
    });
    await adapter.act(() => adapter.refresh(data));
    expect(container.textContent).toBe("one:true");
    await adapter.act(async () => {
      resolve("two");
      await request;
    });
    expect(container.textContent).toBe("two:false");
  });

  test("causality links component delivery to urgent and deferred writes", async () => {
    const value = adapter.atom(1);
    const log = adapter.trace();
    function View() {
      return <div>{adapter.useValue(value) as number}</div>;
    }
    await adapter.act(() => root.render(<View />));
    await adapter.act(() => adapter.set(value, 2));
    expect(log.whyLastDelivery(value).map((entry) => entry.split("#")[0])).toEqual([
      "component-delivery",
      "write",
    ]);
    await adapter.act(() =>
      adapter.startTransitionWrite(() =>
        adapter.update(value, (current) => (current as number) * 2),
      ),
    );
    expect(log.whyLastDelivery(value).map((entry) => entry.split("#")[0])).toContain("write");
    expect(log.events().some((event) => event.kind === "root-commit")).toBe(true);
    log.stop();
  });

  test("lazy and installed SSR state render without corrective work", async () => {
    let initialized = 0;
    const lazy = adapter.atom(
      () => {
        initialized++;
        return 3;
      },
      { label: "count" },
    );
    const json = adapter.serialize([lazy]);
    expect(initialized).toBe(1);
    const client = adapter.atom(
      () => {
        initialized++;
        return 0;
      },
      { label: "count" },
    );
    adapter.initialize(json, [client]);
    let commits = 0;
    function View() {
      const value = adapter.useValue(client);
      React.useLayoutEffect(() => {
        commits++;
      });
      return <div>{String(value)}</div>;
    }
    await adapter.act(() => root.render(<View />));
    expect(container.textContent).toBe("3");
    expect(initialized).toBe(1);
    expect(commits).toBe(1);
  });

  test("writes during render fail loudly", async () => {
    const value = adapter.atom(0);
    function Bad() {
      adapter.set(value, 1);
      return null;
    }
    await expect(adapter.act(() => root.render(<Bad />))).rejects.toThrow("during render");
  });

  test("mutation events bracket React DOM writes exactly", async () => {
    const seen: MutationRecord[] = [];
    const phases: string[] = [];
    const observer = new MutationObserver((records) => {
      seen.push(...records);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    const stop = adapter.onDomMutation((phase) => {
      phases.push(phase);
      if (phase === "start") observer.disconnect();
      else observer.observe(container, { childList: true, subtree: true, characterData: true });
    });
    await adapter.act(() => root.render(<div>React</div>));
    await Promise.resolve();
    expect(seen).toHaveLength(0);
    container.append(document.createElement("span"));
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(phases).toEqual(["start", "stop"]);
    stop();
    observer.disconnect();
  });
});
