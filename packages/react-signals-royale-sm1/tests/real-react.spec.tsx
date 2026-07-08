// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  atom,
  batch,
  computed,
  flushSync,
  initializeAtomState,
  onDomMutation,
  refresh,
  register,
  resetForTest,
  serializeAtomState,
  startTransitionWrite,
  startTrace,
  useIsPending,
  useAtom,
  useCommitted,
  useComputed,
  useSignalEffect,
  useValue,
  type Registration,
} from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let registration: Registration;
const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  resetForTest();
  registration = register();
});

afterEach(async () => {
  await act(async () => {
    for (const mounted of roots) mounted.root.unmount();
  });
  for (const mounted of roots) mounted.container.remove();
  roots.length = 0;
  expect(registration.errors).toEqual([]);
  registration.dispose();
});

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => root.render(node));
  return container;
}

async function unmount(container: HTMLDivElement): Promise<void> {
  const index = roots.findIndex((mounted) => mounted.container === container);
  const mounted = roots[index];
  roots.splice(index, 1);
  await act(async () => mounted.root.unmount());
  container.remove();
}

describe("real React protocol", () => {
  it("urgent writes and an explicit batch each produce one commit", async () => {
    const count = atom(0);
    let commits = 0;
    function App() {
      const value = useValue(count);
      React.useLayoutEffect(() => {
        commits++;
      });
      return <span>{value}</span>;
    }
    const container = await mount(<App />);
    commits = 0;

    await act(async () => count.set(1));
    expect(container.textContent).toBe("1");
    expect(commits).toBe(1);

    commits = 0;
    await act(async () => {
      batch(() => {
        count.set(2);
        count.set(3);
      });
    });
    expect(container.textContent).toBe("3");
    expect(commits).toBe(1);
  });

  it("holds drafts and rebases a transition updater over an urgent updater", async () => {
    const gate = deferred<string>();
    const count = atom(1);
    const blocked = atom(false);
    const data = computed((use) => (blocked.state ? use(gate.promise) : "ready"));

    function App() {
      const pending = useIsPending(data);
      return (
        <span>
          {useValue(count)}:{useValue(data)}:{pending ? "pending" : "settled"}
        </span>
      );
    }
    const container = await mount(
      <React.Suspense fallback={<span>fallback</span>}>
        <App />
      </React.Suspense>,
    );
    expect(container.textContent).toBe("1:ready:settled");

    await act(async () => {
      startTransitionWrite(() => {
        count.update((value) => value * 2);
        blocked.set(true);
      });
    });
    expect(container.textContent).toBe("1:ready:pending");

    await act(async () => count.update((value) => value + 1));
    expect(container.textContent).toBe("2:ready:pending");

    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(container.textContent).toBe("4:done:settled");
  });

  it("keeps sibling readers consistent through an interrupted transition", async () => {
    const gate = deferred<void>();
    const value = atom(0);
    const hold = atom(false);
    const blocker = computed((use) => (hold.state ? use(gate.promise) : undefined));
    const committedFrames: string[] = [];

    function Reader({ name }: { name: string }) {
      return <span data-reader={name}>{useValue(value)}</span>;
    }
    function App() {
      useValue(blocker);
      React.useLayoutEffect(() => {
        const left = document.querySelector('[data-reader="left"]')?.textContent;
        const right = document.querySelector('[data-reader="right"]')?.textContent;
        committedFrames.push(`${left}/${right}`);
      });
      return (
        <div>
          <Reader name="left" />
          <Reader name="right" />
        </div>
      );
    }
    const container = await mount(
      <React.Suspense fallback="fallback">
        <App />
      </React.Suspense>,
    );
    await act(async () => {
      startTransitionWrite(() => {
        value.set(10);
        hold.set(true);
      });
    });
    await act(async () => value.set(3));
    expect(container.textContent).toBe("33");
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(container.textContent).toBe("1010");
    expect(committedFrames.every((frame) => frame.split("/")[0] === frame.split("/")[1])).toBe(
      true,
    );
  });

  it("repairs a subscriber that mounts while a suspending transition is live", async () => {
    const gate = deferred<string>();
    const value = atom("old");
    const blocked = atom(false);
    const data = computed((use) => (blocked.state ? use(gate.promise) : "ready"));
    let showLate!: () => void;

    function Late() {
      return (
        <b>
          late:{useValue(value)}:{useValue(data)}
        </b>
      );
    }
    function App() {
      const [show, setShow] = React.useState(false);
      showLate = () => setShow(true);
      return (
        <span>
          main:{useValue(value)}:{useValue(data)};{show ? <Late /> : null}
        </span>
      );
    }
    const container = await mount(
      <React.Suspense fallback="fallback">
        <App />
      </React.Suspense>,
    );
    await act(async () => {
      startTransitionWrite(() => {
        value.set("new");
        blocked.set(true);
      });
    });
    await act(async () => showLate());
    expect(container.textContent).toBe("main:old:ready;late:old:ready");
    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(container.textContent).toBe("main:new:done;late:new:done");
  });

  it("serves stale data during refresh and preserves thenable identity", async () => {
    const requests = [deferred<string>(), deferred<string>()];
    let request = 0;
    let fetches = 0;
    const remote = computed(() => {
      fetches++;
      return requests[request].promise;
    });
    function App() {
      const pending = useIsPending(remote);
      return (
        <span>
          {useValue(remote) as unknown as string}:{pending ? "pending" : "settled"}
        </span>
      );
    }
    const container = await mount(
      <React.Suspense fallback={<span>loading</span>}>
        <App />
      </React.Suspense>,
    );
    expect(container.textContent).toBe("loading");
    await act(async () => {
      requests[0].resolve("first");
      await requests[0].promise;
    });
    expect(container.textContent).toBe("first:settled");
    expect(fetches).toBe(1);

    request = 1;
    await act(async () => refresh(remote));
    expect(container.textContent).toBe("first:pending");
    expect(container.textContent).not.toContain("loading");
    await act(async () => {
      requests[1].resolve("second");
      await requests[1].promise;
    });
    expect(container.textContent).toBe("second:settled");
    expect(fetches).toBe(2);
  });

  it("flushSync excludes a held draft and the draft later rebases", async () => {
    const gate = deferred<string>();
    const value = atom(1);
    const blocked = atom(false);
    const data = computed((use) => (blocked.state ? use(gate.promise) : "ready"));
    function App() {
      return (
        <span>
          {useValue(value)}:{useValue(data)}
        </span>
      );
    }
    const container = await mount(
      <React.Suspense fallback="fallback">
        <App />
      </React.Suspense>,
    );
    await act(async () => {
      startTransitionWrite(() => {
        value.update((current) => current * 3);
        blocked.set(true);
      });
    });
    await act(async () => {
      flushSync(() => value.update((current) => current * 2));
    });
    expect(container.textContent).toBe("2:ready");
    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(container.textContent).toBe("6:done");
  });

  it("one transition batch stays consistent across two roots", async () => {
    const gate = deferred<string>();
    const value = atom("old");
    const blocked = atom(false);
    const data = computed((use) => (blocked.state ? use(gate.promise) : "ready"));
    function App({ name }: { name: string }) {
      return (
        <span>
          {name}:{useValue(value)}:{useValue(data)}
        </span>
      );
    }
    const first = await mount(
      <React.Suspense fallback="first fallback">
        <App name="first" />
      </React.Suspense>,
    );
    const second = await mount(
      <React.Suspense fallback="second fallback">
        <App name="second" />
      </React.Suspense>,
    );
    await act(async () => {
      startTransitionWrite(() => {
        value.set("new");
        blocked.set(true);
      });
    });
    expect(first.textContent).toBe("first:old:ready");
    expect(second.textContent).toBe("second:old:ready");
    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(first.textContent).toBe("first:new:done");
    expect(second.textContent).toBe("second:new:done");
  });

  it("StrictMode nets one subscription and lifetime observation", async () => {
    let starts = 0;
    let stops = 0;
    const value = atom(0, {
      effect() {
        starts++;
        return () => {
          stops++;
        };
      },
    });
    let renders = 0;
    function App() {
      renders++;
      return <span>{useValue(value)}</span>;
    }
    const container = await mount(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
    await Promise.resolve();
    expect(starts).toBe(1);
    await unmount(container);
    await Promise.resolve();
    expect(stops).toBe(1);
    const rendersAtUnmount = renders;
    value.set(1);
    expect(renders).toBe(rendersAtUnmount);
  });

  it("rejects a write during render", async () => {
    const value = atom(0);
    function Bad() {
      value.set(1);
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await expect(act(async () => root.render(<Bad />))).rejects.toThrow(/during render/);
  });

  it("brackets React DOM changes so an observer can ignore them", async () => {
    const value = atom("a");
    function App() {
      return <span>{useValue(value)}</span>;
    }
    const container = await mount(<App />);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((next) => {
      for (const record of next) records.push(record);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    const stop = onDomMutation((phase, root) => {
      if (root !== container) return;
      if (phase === "start") observer.disconnect();
      else observer.observe(container, { childList: true, subtree: true, characterData: true });
    });
    await act(async () => value.set("b"));
    await Promise.resolve();
    expect(records).toEqual([]);
    container.append(document.createTextNode("third-party"));
    await Promise.resolve();
    expect(records.length).toBeGreaterThan(0);
    stop();
    observer.disconnect();
  });

  it("hydrates installed state without running the lazy initializer or repairing", async () => {
    const source = atom(42, { key: "answer" });
    const json = serializeAtomState({ answer: source });
    let initializes = 0;
    const client = atom(
      () => {
        initializes++;
        return 0;
      },
      { key: "answer" },
    );
    initializeAtomState(json, { answer: client });
    expect(initializes).toBe(0);
    let renders = 0;
    function App() {
      renders++;
      return <span>{useValue(client)}</span>;
    }
    const container = await mount(<App />);
    expect(container.textContent).toBe("42");
    expect(initializes).toBe(0);
    expect(renders).toBe(1);
  });

  it("records a causal chain through lane retirement to the originating write", async () => {
    const trace = startTrace(128);
    const value = atom(0, { label: "count" });
    function App() {
      return <span>{useValue(value)}</span>;
    }
    const container = await mount(<App />);
    await act(async () => startTransitionWrite(() => value.set(1)));
    expect(container.textContent).toBe("1");
    const kinds = new Set<string>();
    for (const event of trace.events()) kinds.add(event.kind);
    expect(kinds.has("write")).toBe(true);
    expect(kinds.has("batch open")).toBe(true);
    expect(kinds.has("render pass start")).toBe(true);
    expect(kinds.has("render pass end")).toBe(true);
    expect(kinds.has("root commit")).toBe(true);
    expect(kinds.has("batch retire")).toBe(true);
    expect(trace.whyLastDelivery(value).join("\n")).toMatch(
      /committed lane[\s\S]*batch retire[\s\S]*write/,
    );
    trace.stop();
  });

  it("runs signal effects only after a deferred value commits", async () => {
    const gate = deferred<string>();
    const value = atom(0);
    const blocked = atom(false);
    const data = computed((use) => (blocked.state ? use(gate.promise) : "ready"));
    const seen: number[] = [];
    function App() {
      const run = React.useCallback(() => {
        seen.push(value.state);
      }, []);
      useSignalEffect(run);
      return (
        <span>
          {useValue(value)}:{useValue(data)}
        </span>
      );
    }
    const container = await mount(
      <React.Suspense fallback="fallback">
        <App />
      </React.Suspense>,
    );
    expect(seen).toEqual([0]);
    await act(async () => {
      startTransitionWrite(() => {
        value.set(1);
        blocked.set(true);
      });
    });
    expect(container.textContent).toBe("0:ready");
    expect(seen).toEqual([0]);
    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(container.textContent).toBe("1:done");
    expect(seen).toEqual([0, 1]);
  });

  it("lets an urgent input commit after a transition has actually yielded", async () => {
    const draft = atom(0);
    const urgent = atom(0);
    let draftRenders = 0;
    function Work({ active }: { active: boolean }) {
      if (active) {
        const end = performance.now() + 0.15;
        while (performance.now() < end) {
          // Deliberately occupy one render slice.
        }
        draftRenders++;
      }
      return null;
    }
    function App() {
      const draftValue = useValue(draft);
      const urgentValue = useValue(urgent);
      const work: React.ReactNode[] = [];
      for (let index = 0; index < 500; index++) {
        work.push(<Work key={index} active={draftValue === 1} />);
      }
      return (
        <div>
          {urgentValue}:{draftValue}
          {work}
        </div>
      );
    }
    const container = await mount(<App />);
    const priorActSetting = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    startTransitionWrite(() => draft.set(1));
    for (let attempt = 0; attempt < 20 && draftRenders === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(draftRenders).toBeGreaterThan(0);
    expect(container.textContent).toBe("0:0");
    flushSync(() => urgent.set(1));
    expect(container.textContent).toBe("1:0");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      priorActSetting;
    await act(async () => undefined);
    expect(container.textContent).toBe("1:1");
  }, 10_000);

  it("keeps a transition-owned refresh in that transition through settlement", async () => {
    const requests = [deferred<string>(), deferred<string>()];
    let request = 0;
    const remote = computed(() => requests[request].promise);
    function App() {
      return (
        <span>
          {useValue(remote) as unknown as string}:{useIsPending(remote) ? "pending" : "settled"}
        </span>
      );
    }
    const container = await mount(
      <React.Suspense fallback="loading">
        <App />
      </React.Suspense>,
    );
    await act(async () => {
      requests[0].resolve("one");
      await requests[0].promise;
    });
    expect(container.textContent).toBe("one:settled");
    request = 1;
    await act(async () => startTransitionWrite(() => refresh(remote)));
    expect(container.textContent).toBe("one:pending");
    await act(async () => {
      requests[1].resolve("two");
      await requests[1].promise;
    });
    expect(container.textContent).toBe("two:settled");
  });

  it("materializes lazy atoms at first render and before set-before-read", async () => {
    let firstInitializes = 0;
    const first = atom(() => {
      firstInitializes++;
      return 4;
    });
    expect(firstInitializes).toBe(0);
    function App() {
      return <span>{useValue(first)}</span>;
    }
    const container = await mount(<App />);
    expect(container.textContent).toBe("4");
    expect(firstInitializes).toBe(1);

    let secondInitializes = 0;
    const second = atom(() => {
      secondInitializes++;
      return 5;
    });
    second.set(7);
    expect(secondInitializes).toBe(1);
    expect(second.state).toBe(7);
  });

  it("supports component atoms, component computeds, and committed reads", async () => {
    const external = atom(2);
    let increment!: () => void;
    function App() {
      const local = useAtom(1);
      increment = () => local.update((value) => value + 1);
      const sum = useComputed(() => local.state + external.state, [local]);
      const onScreen = useCommitted(external);
      return (
        <span>
          {sum}:{onScreen}
        </span>
      );
    }
    const container = await mount(<App />);
    expect(container.textContent).toBe("3:2");
    await act(async () => increment());
    expect(container.textContent).toBe("4:2");
    await act(async () => external.set(3));
    expect(container.textContent).toBe("5:3");
  });
});
