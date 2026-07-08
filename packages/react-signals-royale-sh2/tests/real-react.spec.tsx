/** @vitest-environment jsdom */
import React, { StrictMode, Suspense, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  atom,
  asyncComputed,
  batch,
  initializeAtomState,
  onDomMutation,
  read,
  resetForTest,
  set,
  serializeAtomState,
  startTransitionWrite,
  trace,
  update,
  useIsPending,
  useValue,
} from "../src";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  resetForTest();
});
afterEach(async () => {
  await React.act(() => {
    for (const root of roots) root.unmount();
  });
  roots = [];
});

describe("real React protocol", () => {
  test("an unobserved transition retires at quiescence", async () => {
    const value = atom(0);
    startTransitionWrite(() => set(value, 1));
    expect(read(value)).toBe(0);
    await Promise.resolve();
    expect(read(value)).toBe(1);
  });

  test("urgent and batched writes each produce one commit", async () => {
    const value = atom(0);
    const commits: number[] = [];
    function App() {
      const current = useValue(value);
      useLayoutEffect(() => {
        commits.push(current);
      });
      return <span>{current}</span>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    await React.act(() => set(value, 1));
    await React.act(() =>
      batch(() => {
        set(value, 2);
        set(value, 3);
      }),
    );
    expect(container.textContent).toBe("3");
    expect(commits).toEqual([0, 1, 3]);
  });

  test("urgent work commits while a transition is suspended, then rebases", async () => {
    const value = atom(1);
    let setSlow!: (value: boolean) => void;
    let resolve!: () => void;
    let ready = false;
    const gate = new Promise<void>((done) => {
      resolve = () => {
        ready = true;
        done();
      };
    });
    function App() {
      const current = useValue(value);
      const pending = useIsPending(value);
      const [slow, changeSlow] = useState(false);
      setSlow = changeSlow;
      if (slow && !ready) throw gate;
      return (
        <span>
          {current}:{pending ? "pending" : "idle"}
        </span>
      );
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    React.act(() => {
      startTransitionWrite(() => {
        update(value, (x) => x * 2);
        setSlow(true);
      });
    });
    await React.act(() => update(value, (x) => x + 1));
    expect(container.textContent).toBe("2:pending");
    await React.act(async () => {
      resolve();
      await gate;
    });
    expect(container.textContent).toBe("3:idle");
  });

  test("siblings read one transition world", async () => {
    const value = atom(0);
    const seen: string[] = [];
    function Reader() {
      return <>{useValue(value)}</>;
    }
    function App() {
      useLayoutEffect(() => {
        seen.push(document.body.textContent ?? "");
      });
      return (
        <>
          <Reader />/<Reader />
        </>
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    await React.act(() => startTransitionWrite(() => set(value, 1)));
    expect(container.textContent).toBe("1/1");
    expect(seen.every((text) => !text.includes("0/1") && !text.includes("1/0"))).toBe(true);
    container.remove();
  });

  test("StrictMode nets one lifetime observation", async () => {
    const starts = vi.fn();
    const stops = vi.fn();
    const value = atom(0, {
      effect: () => {
        starts();
        return stops;
      },
    });
    function App() {
      return <>{useValue(value)}</>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(async () => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
      await Promise.resolve();
    });
    expect(starts).toHaveBeenCalledTimes(1);
    await React.act(async () => {
      root.render(null);
      await Promise.resolve();
    });
    expect(stops).toHaveBeenCalledTimes(1);
  });

  test("mutation events let an observer ignore React writes", async () => {
    const value = atom("a");
    function App() {
      return <span>{useValue(value)}</span>;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((items) => records.push(...items));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    const stop = onDomMutation((phase) => {
      if (phase === "start") observer.disconnect();
      else observer.observe(container, { childList: true, subtree: true, characterData: true });
    });
    await React.act(() => root.render(<App />));
    await React.act(() => set(value, "b"));
    container.append(document.createElement("i"));
    await Promise.resolve();
    expect(records).toHaveLength(1);
    expect(records[0].addedNodes[0].nodeName).toBe("I");
    stop();
    observer.disconnect();
    container.remove();
  });

  test("lazy initialization happens at the first render read", async () => {
    const initialize = vi.fn(() => 5);
    const value = atom(initialize);
    expect(initialize).not.toHaveBeenCalled();
    function App() {
      return <>{useValue(value)}</>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    expect(initialize).toHaveBeenCalledOnce();
    expect(read(value)).toBe(5);
  });

  test("Suspense first load and stale refetch use stable thenables", async () => {
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const request = atom<Promise<string>>(first);
    const resource = asyncComputed((use) => use(read(request)));
    function App() {
      const value = useValue(resource);
      return (
        <span>
          {value}:{useIsPending(resource) ? "pending" : "idle"}
        </span>
      );
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(() =>
      root.render(
        <Suspense fallback="loading">
          <App />
        </Suspense>,
      ),
    );
    expect(container.textContent).toBe("loading");
    await React.act(async () => {
      resolveFirst("first");
      await first;
    });
    expect(container.textContent).toBe("first:idle");

    let resolveSecond!: (value: string) => void;
    const second = new Promise<string>((resolve) => {
      resolveSecond = resolve;
    });
    await React.act(() => set(request, second));
    expect(container.textContent).toBe("first:pending");
    await React.act(async () => {
      resolveSecond("second");
      await second;
    });
    expect(container.textContent).toBe("second:idle");

    let resolveThird!: (value: string) => void;
    const third = new Promise<string>((resolve) => {
      resolveThird = resolve;
    });
    await React.act(async () => {
      startTransitionWrite(() => set(request, third));
      await Promise.resolve();
    });
    expect(container.textContent).toBe("second:pending");
    await React.act(async () => {
      resolveThird("third");
      await third;
    });
    expect(container.textContent).toBe("third:idle");
  });

  test("one transition advances two roots consistently", async () => {
    const value = atom(0);
    function App() {
      return <>{useValue(value)}</>;
    }
    const left = document.createElement("div");
    const right = document.createElement("div");
    const leftRoot = createRoot(left);
    const rightRoot = createRoot(right);
    roots.push(leftRoot, rightRoot);
    await React.act(() => {
      leftRoot.render(<App />);
      rightRoot.render(<App />);
    });
    await React.act(() => startTransitionWrite(() => set(value, 1)));
    expect([left.textContent, right.textContent]).toEqual(["1", "1"]);
  });

  test("a subscriber mounted mid-transition is pinned to the live batch", async () => {
    const value = atom(0);
    let setSlow!: (value: boolean) => void;
    let resolve!: () => void;
    let ready = false;
    const gate = new Promise<void>((done) => {
      resolve = () => {
        ready = true;
        done();
      };
    });
    function HoldingRoot() {
      const current = useValue(value);
      const [slow, changeSlow] = useState(false);
      setSlow = changeSlow;
      if (slow && !ready) throw gate;
      return <>{current}</>;
    }
    const commits: number[] = [];
    function LateReader() {
      const current = useValue(value);
      useLayoutEffect(() => {
        commits.push(current);
      });
      return <>{current}</>;
    }
    const first = document.createElement("div");
    const second = document.createElement("div");
    const firstRoot = createRoot(first);
    const secondRoot = createRoot(second);
    roots.push(firstRoot, secondRoot);
    await React.act(() => firstRoot.render(<HoldingRoot />));
    React.act(() =>
      startTransitionWrite(() => {
        set(value, 1);
        setSlow(true);
      }),
    );
    await React.act(() => secondRoot.render(<LateReader />));
    expect(commits).toEqual([0, 1]);
    await React.act(async () => {
      resolve();
      await gate;
    });
    expect([first.textContent, second.textContent]).toEqual(["1", "1"]);
  });

  test("a suspending subscriber mounted mid-transition keeps its settled screen", async () => {
    const request = atom<Promise<string>>(Promise.resolve("old"));
    const resource = asyncComputed((use) => use(read(request)));
    function Reader() {
      return <>{useValue(resource)}</>;
    }
    const first = document.createElement("div");
    const second = document.createElement("div");
    const firstRoot = createRoot(first);
    const secondRoot = createRoot(second);
    roots.push(firstRoot, secondRoot);
    await React.act(async () => {
      firstRoot.render(
        <Suspense fallback="loading">
          <Reader />
        </Suspense>,
      );
    });
    expect(first.textContent).toBe("old");
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    React.act(() => startTransitionWrite(() => set(request, pending)));
    await React.act(() =>
      secondRoot.render(
        <Suspense fallback="loading">
          <Reader />
        </Suspense>,
      ),
    );
    expect([first.textContent, second.textContent]).toEqual(["old", "old"]);
    await React.act(async () => {
      resolve("new");
      await pending;
    });
    expect([first.textContent, second.textContent]).toEqual(["new", "new"]);
  });

  test("flushSync leaves a suspended transition out of its commit", async () => {
    const value = atom(1);
    let setSlow!: (value: boolean) => void;
    let resolve!: () => void;
    let ready = false;
    const gate = new Promise<void>((done) => {
      resolve = () => {
        ready = true;
        done();
      };
    });
    function App() {
      const current = useValue(value);
      const [slow, changeSlow] = useState(false);
      setSlow = changeSlow;
      if (slow && !ready) throw gate;
      return <>{current}</>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    React.act(() =>
      startTransitionWrite(() => {
        set(value, 2);
        setSlow(true);
      }),
    );
    const { flushSync } = await import("react-dom");
    flushSync(() => set(value, 3));
    expect(container.textContent).toBe("3");
    await React.act(async () => {
      resolve();
      await gate;
    });
    expect(container.textContent).toBe("3");
  });

  test("unmounted subscribers receive no component deliveries", async () => {
    const value = atom(0);
    const log = trace();
    function App() {
      return <>{useValue(value)}</>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    await React.act(() => root.render(null));
    const deliveries = log.events().filter((event) => event.kind === "component delivery").length;
    await React.act(() => set(value, 1));
    expect(log.events().filter((event) => event.kind === "component delivery")).toHaveLength(
      deliveries,
    );
    log.stop();
  });

  test("causality links a delivery to its write", async () => {
    const value = atom(0);
    const log = trace();
    function App() {
      return <>{useValue(value)}</>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    await React.act(() => set(value, 1));
    const explanation = log.whyLastDelivery(value);
    expect(explanation.some((line) => line.includes("component delivery"))).toBe(true);
    expect(explanation.some((line) => line.includes("write"))).toBe(true);
    log.stop();
  });

  test("branch updates show 2 urgently, then 6 with the transition cause", async () => {
    const value = atom(1);
    const log = trace();
    let setSlow!: (value: boolean) => void;
    let resolve!: () => void;
    let ready = false;
    const gate = new Promise<void>((done) => {
      resolve = () => {
        ready = true;
        done();
      };
    });
    function App() {
      const current = useValue(value);
      const [slow, changeSlow] = useState(false);
      setSlow = changeSlow;
      if (slow && !ready) throw gate;
      return <>{current}</>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    React.act(() =>
      startTransitionWrite(() => {
        update(value, (x) => x * 3);
        setSlow(true);
      }),
    );
    await React.act(() => update(value, (x) => x * 2));
    expect(container.textContent).toBe("2");
    expect(log.whyLastDelivery(value).join("\n")).not.toContain("batch 1");
    await React.act(async () => {
      resolve();
      await gate;
    });
    expect(container.textContent).toBe("6");
    expect(log.whyLastDelivery(value).join("\n")).toContain("batch 1");
    log.stop();
  });

  test("time slicing commits urgent input before a large transition", async () => {
    const value = atom(0);
    let setUrgent!: (value: number) => void;
    const commits: string[] = [];
    function Item({ current }: { current: number }) {
      const until = performance.now() + 0.05;
      while (performance.now() < until) {}
      return <i>{current}</i>;
    }
    function App() {
      const current = useValue(value);
      const [urgent, changeUrgent] = useState(0);
      setUrgent = changeUrgent;
      useLayoutEffect(() => {
        commits.push(`${urgent}:${current}`);
      });
      const items = [];
      for (let i = 0; i < 800; i++) items.push(<Item key={i} current={current} />);
      return <div data-urgent={urgent}>{items}</div>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    root.render(<App />);
    for (let i = 0; i < 100 && container.querySelectorAll("i").length !== 800; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    startTransitionWrite(() => set(value, 1));
    setUrgent(1);
    for (let i = 0; i < 100 && !commits.includes("1:1"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(commits.indexOf("1:0")).toBeGreaterThan(commits.indexOf("0:0"));
    expect(commits.indexOf("1:1")).toBeGreaterThan(commits.indexOf("1:0"));
    expect(container.querySelector("i")?.textContent).toBe("1");
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  test("writes during render fail loudly", async () => {
    const value = atom(0);
    class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? "failed" : this.props.children;
      }
    }
    function Bad() {
      set(value, 1);
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await React.act(() =>
      root.render(
        <Boundary>
          <Bad />
        </Boundary>,
      ),
    );
    expect(container.textContent).toBe("failed");
    expect(consoleError.mock.calls.flat().join(" ")).toContain(
      "Signals cannot be written during render",
    );
    consoleError.mockRestore();
  });

  test("SSR state installation matches the first client commit", async () => {
    const server = atom(9, { key: "count" });
    const json = serializeAtomState([server]);
    resetForTest();
    const initialize = vi.fn(() => 0);
    const client = atom(initialize, { key: "count" });
    initializeAtomState(json, [client]);
    const commits = vi.fn();
    function App() {
      const value = useValue(client);
      useLayoutEffect(commits);
      return <>{value}</>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    expect(container.textContent).toBe("9");
    expect(initialize).not.toHaveBeenCalled();
    expect(commits).toHaveBeenCalledOnce();
  });
});
