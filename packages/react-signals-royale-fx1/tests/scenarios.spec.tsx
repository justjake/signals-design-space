// @vitest-environment jsdom
/**
 * The real-React gate: RULES scenarios 1-18 driven through this package's own
 * API against the fx1 fork build (raw createRoot + act, no RTL).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  atom,
  computed,
  read,
  latest,
  committed,
  isPending,
  refresh,
  effect,
  serializeAtomState,
  initializeAtomState,
  startTrace,
  resetEngine,
  type Atom,
} from "signals-royale-fx1";
import { flushSync } from "react-dom";
import {
  useValue,
  useIsPending,
  useCommitted,
  startTransitionWrite,
  onDomMutation,
} from "../src/index";
import { makeHarness, deferred, act, type Harness } from "./helpers";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

function Reader({ id, a }: { id: string; a: Atom<number> }) {
  return (
    <span>
      {id}:{useValue(a)};
    </span>
  );
}

describe("scenario 1: commit granularity", () => {
  test("one urgent write, one commit; batched writes, one commit", async () => {
    const a = atom(0);
    const b = atom(0);
    let renders = 0;
    function App() {
      renders++;
      return (
        <span>
          {useValue(a)},{useValue(b)}
        </span>
      );
    }
    const { container } = await h.mount(<App />);
    expect(h.text(container)).toBe("0,0");
    const before = renders;
    await act(async () => {
      a.set(1);
    });
    expect(h.text(container)).toBe("1,0");
    expect(renders).toBe(before + 1);
    await act(async () => {
      a.set(2);
      b.set(2);
    });
    expect(h.text(container)).toBe("2,2");
    expect(renders).toBe(before + 2);
  });
});

describe("scenarios 2+3+13: transition drafts, urgent rebase, replay arithmetic", () => {
  test("drafts invisible; urgent commits alone; ops replay in scheduling order", async () => {
    const a = atom(1);
    const hold = atom(false);
    const gate = deferred<void>();
    const layoutSeen: number[] = [];
    function App() {
      const v = useValue(a);
      const held = useValue(hold);
      React.useLayoutEffect(() => {
        layoutSeen.push(v);
      });
      if (held && !gate.settled) throw gate.promise;
      return <span>v:{v}</span>;
    }
    const { container } = await h.mount(
      <React.Suspense fallback={<i>fb</i>}>
        <App />
      </React.Suspense>,
    );
    await act(async () => {
      startTransitionWrite(() => {
        a.update((x) => x + 2);
        hold.set(true);
      });
    });
    // Transition held: no draft leak, no fallback; the read family agrees.
    expect(h.text(container)).toBe("v:1");
    expect(read(a)).toBe(1);
    expect(committed(a)).toBe(1);
    expect(latest(a)).toBe(3);
    expect(isPending(a)).toBe(true);
    await act(async () => {
      a.update((x) => x * 2);
    });
    expect(h.text(container)).toBe("v:2"); // urgent alone: 1*2
    expect(read(a)).toBe(2);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    // Scheduling-order replay: (1+2)*2, never a torn 3, never 4.
    expect(h.text(container)).toBe("v:6");
    expect(read(a)).toBe(6);
    expect(isPending(a)).toBe(false);
    const collapsed = layoutSeen.filter((v, i) => i === 0 || v !== layoutSeen[i - 1]);
    expect(collapsed).toEqual([1, 2, 6]);
  });
});

describe("scenario 4: sibling consistency", () => {
  test("two readers of one atom never disagree within a render", async () => {
    const a = atom(0);
    const pairs: Array<[number, number]> = [];
    function Pair() {
      const v1 = useValue(a);
      const v2 = useValue(a);
      pairs.push([v1, v2]);
      return (
        <b>
          {v1},{v2};
        </b>
      );
    }
    const { container } = await h.mount(
      <>
        <Pair />
        <Pair />
      </>,
    );
    await act(async () => {
      a.set(1);
      startTransitionWrite(() => a.set(2));
    });
    await act(async () => {});
    expect(h.text(container)).toBe("2,2;2,2;");
    for (const [v1, v2] of pairs) expect(v1).toBe(v2);
  });
});

describe("scenario 5: mount mid-transition", () => {
  test("late subscriber shows committed value, then joins the transition commit", async () => {
    const a = atom(0);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      if (v > 0 && !gate.settled) throw gate.promise;
      return <span>s:{v};</span>;
    }
    function App({ extra }: { extra: boolean }) {
      return (
        <>
          <Reader id="r1" a={a} />
          <React.Suspense fallback={<span>fb;</span>}>
            <Suspender />
          </React.Suspense>
          {extra ? <Reader id="r2" a={a} /> : null}
        </>
      );
    }
    const { root, container } = await h.mount(<App extra={false} />);
    await act(async () => {
      startTransitionWrite(() => a.set(1));
    });
    expect(h.text(container)).toBe("r1:0;s:0;");
    await act(async () => {
      root.render(<App extra={true} />);
    });
    expect(h.text(container)).toBe("r1:0;s:0;r2:0;"); // committed world only
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(h.text(container)).toBe("r1:1;s:1;r2:1;"); // one world, one commit
  });
});

describe("scenario 6: flushSync excludes deferred work", () => {
  test("sync commit never carries the held transition", async () => {
    const a = atom(0);
    const b = atom(0);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      if (v > 0 && !gate.settled) throw gate.promise;
      return <span>s:{v};</span>;
    }
    const { container } = await h.mount(
      <>
        <Reader id="a" a={a} />
        <Reader id="b" a={b} />
        <React.Suspense fallback={null}>
          <Suspender />
        </React.Suspense>
      </>,
    );
    await act(async () => {
      startTransitionWrite(() => a.set(9));
    });
    await act(async () => {
      flushSync(() => b.set(1));
      expect(h.text(container)).toBe("a:0;b:1;s:0;");
    });
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(h.text(container)).toBe("a:9;b:1;s:9;");
  });
});

describe("scenario 7: one transition, two roots", () => {
  test("per-root consistency and per-root committed views", async () => {
    const a = atom(0);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      if (v > 0 && !gate.settled) throw gate.promise;
      return <span>s:{v};</span>;
    }
    const one = await h.mount(
      <React.Suspense fallback={null}>
        <Suspender />
      </React.Suspense>,
    );
    const two = await h.mount(<Reader id="r" a={a} />);
    await act(async () => {
      startTransitionWrite(() => a.set(1));
    });
    // Root one holds; root two commits its slice of the same batch.
    expect(h.text(one.container)).toBe("s:0;");
    expect(h.text(two.container)).toBe("r:1;");
    expect(committed(a, one.container)).toBe(0);
    expect(committed(a, two.container)).toBe(1);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(h.text(one.container)).toBe("s:1;");
    expect(committed(a, one.container)).toBe(1);
  });
});

describe("scenarios 8+9+14: StrictMode, unmount, lifetime effects", () => {
  test("StrictMode double-mount nets one observation; unmount stops deliveries and cleans up", async () => {
    const log: string[] = [];
    const a = atom(0, {
      onObserved: (ctx) => {
        log.push(`observe:${ctx.get()}`);
        ctx.set(42);
        return () => log.push("unobserve");
      },
    });
    let renders = 0;
    function App() {
      renders++;
      return <span>{useValue(a)}</span>;
    }
    const { root, container } = await h.mount(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
    await act(async () => {});
    expect(log).toEqual(["observe:0"]); // double-mount coalesced
    expect(h.text(container)).toBe("42"); // ctx.set delivered
    await act(async () => {
      root.render(null);
    });
    await act(async () => {});
    expect(log).toEqual(["observe:0", "unobserve"]);
    const before = renders;
    await act(async () => {
      a.set(7);
      startTransitionWrite(() => a.set(8));
    });
    await act(async () => {});
    expect(renders).toBe(before); // unmounted: no deliveries
  });

  test("engine effects and React readers share one observation across the union", async () => {
    const log: string[] = [];
    const a = atom(0, {
      onObserved: () => {
        log.push("observe");
        return () => log.push("unobserve");
      },
    });
    const dispose = effect(() => {
      void read(a);
    });
    await act(async () => {});
    expect(log).toEqual(["observe"]);
    const { root } = await h.mount(<Reader id="r" a={a} />);
    await act(async () => {});
    expect(log).toEqual(["observe"]); // still one observation
    dispose();
    await act(async () => {});
    expect(log).toEqual(["observe"]); // React reader still watching
    await act(async () => {
      root.render(null);
    });
    await act(async () => {});
    expect(log).toEqual(["observe", "unobserve"]);
  });
});

describe("scenario 10: write-during-render fails loudly", () => {
  test("a set() in a component body throws synchronously", async () => {
    const a = atom(0);
    let thrown: unknown;
    function Bad() {
      const v = useValue(a);
      if (v === 0) {
        try {
          a.set(1);
        } catch (e) {
          thrown = e;
        }
      }
      return <span>{v}</span>;
    }
    const { container } = await h.mount(<Bad />);
    expect(String(thrown)).toMatch(/during render/);
    expect(h.text(container)).toBe("0");
  });
});
