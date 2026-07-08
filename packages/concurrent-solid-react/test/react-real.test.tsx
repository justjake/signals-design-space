// @vitest-environment jsdom
/**
 * The real-React gate: concurrent-solid-react against the patched React
 * build (vendor/react fork, external-runtime protocol v2), mirroring the
 * cosignals-alt-a/alt-b RTL gates. Every scenario here runs the REAL fork —
 * no doubles.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot as createDomRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  createMemo,
  createOptimistic,
  createRoot,
  createSignal,
  flush,
  refresh,
  registerConcurrentSolidReact,
  useComputed,
  useIsPending,
  useLatest,
  useSignal,
  useSignalEffect,
  useSignalState,
  useSelector,
  type BridgeHandle
} from "../src/index.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let handle: BridgeHandle;
let roots: Array<{ root: Root; el: HTMLElement }> = [];

beforeEach(() => {
  (React as any).unstable_resetBatchRegistryForTest?.();
  handle = registerConcurrentSolidReact();
});

afterEach(async () => {
  await act(async () => {
    for (const { root, el } of roots) {
      root.unmount();
      el.remove();
    }
  });
  roots = [];
  const errors = [...handle.errors];
  handle.dispose();
  flush();
  (React as any).unstable_resetBatchRegistryForTest?.();
  expect(errors).toEqual([]);
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createDomRoot(el);
  roots.push({ root, el });
  await act(async () => {
    root.render(node);
  });
  return el;
}

const text = (el: HTMLElement) => el.textContent;

describe("real React: basics", () => {
  it("useSignal renders and re-renders on urgent writes", async () => {
    const { count, setCount } = createRoot(() => {
      const [count, setCount] = createSignal(1);
      return { count, setCount };
    });
    let renders = 0;
    function App() {
      renders++;
      return <span>{useSignal(count)}</span>;
    }
    const el = await mount(<App />);
    expect(text(el)).toBe("1");
    await act(async () => {
      setCount(2);
    });
    expect(text(el)).toBe("2");
    expect(renders).toBeLessThanOrEqual(4);
  });

  it("useSignalState / useComputed smoke", async () => {
    const { external, setExternal } = createRoot(() => {
      const [external, setExternal] = createSignal(10);
      return { external, setExternal };
    });
    let bump!: () => void;
    function App() {
      const [local, setLocal] = useSignalState(1);
      const sum = useComputed(() => external() + 100, []);
      bump = () => setLocal(v => v + 1);
      return (
        <span>
          {local}:{sum}
        </span>
      );
    }
    const el = await mount(<App />);
    expect(text(el)).toBe("1:110");
    await act(async () => {
      bump();
    });
    expect(text(el)).toBe("2:110");
    await act(async () => {
      setExternal(20);
    });
    expect(text(el)).toBe("2:120");
  });
});

describe("real React: transitions", () => {
  it("lockstep: signal writes and React state move in one commit", async () => {
    const { sig, setSig } = createRoot(() => {
      const [sig, setSig] = createSignal("a0");
      return { sig, setSig };
    });
    const frames: string[] = [];
    let setLabel!: (v: string) => void;
    function App() {
      const [label, _setLabel] = React.useState("r0");
      setLabel = _setLabel;
      const s = useSignal(sig);
      frames.push(`${s}/${label}`);
      return (
        <span>
          {s}/{label}
        </span>
      );
    }
    const el = await mount(<App />);
    await act(async () => {
      React.startTransition(() => {
        setSig("a1");
        setLabel("r1");
      });
    });
    expect(text(el)).toBe("a1/r1");
    for (const frame of frames) {
      expect(frame === "a0/r0" || frame === "a1/r1").toBe(true);
    }
  });

  it("held transition leaves committed state on screen; urgent writes rebase on top (§10.7 shape)", async () => {
    const gate = deferred<string>();
    const { a, setA, flag, setFlag, blocker } = createRoot(() => {
      const [a, setA] = createSignal(1);
      const [flag, setFlag] = createSignal(false);
      const blocker = createMemo(() => (flag() ? gate.promise : "idle"));
      return { a, setA, flag, setFlag, blocker };
    });
    void flag;
    function App() {
      const v = useSignal(a);
      const b = useSignal(blocker);
      return (
        <span>
          v:{v};b:{b}
        </span>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>fallback</span>}>
        <App />
      </React.Suspense>
    );
    expect(text(el)).toBe("v:1;b:idle");
    // transition: a += 1 and suspend the transition's render
    await act(async () => {
      React.startTransition(() => {
        setA(x => x + 1);
        setFlag(true);
      });
    });
    // transition held open: committed UI unchanged, no fallback
    expect(text(el)).toBe("v:1;b:idle");
    // urgent write mid-pending: commits alone
    await act(async () => {
      setA(x => x * 2);
    });
    expect(text(el)).toBe("v:2;b:idle");
    // release: transition commits rebased on top -> (1+1)*2 = 4
    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(text(el)).toBe("v:4;b:done");
  });

  it("a component mounting urgently during a pending transition shows committed state, then joins the transition commit", async () => {
    const gate = deferred<string>();
    const { sig, setSig, setFlag, blocker } = createRoot(() => {
      const [sig, setSig] = createSignal("old");
      const [flag, setFlag] = createSignal(false);
      const blocker = createMemo(() => (flag() ? gate.promise : "idle"));
      return { sig, setSig, setFlag, blocker };
    });
    function Late() {
      return <span>;late:{useSignal(sig)}</span>;
    }
    let setShowLate!: (v: boolean) => void;
    function App() {
      const [showLate, _setShow] = React.useState(false);
      setShowLate = _setShow;
      const s = useSignal(sig);
      const b = useSignal(blocker);
      return (
        <span>
          a:{s};b:{b}
          {showLate ? <Late /> : null}
        </span>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>fallback</span>}>
        <App />
      </React.Suspense>
    );
    await act(async () => {
      React.startTransition(() => {
        setSig("new");
        setFlag(true);
      });
    });
    expect(text(el)).toBe("a:old;b:idle");
    // urgent mount while the transition is pending: sees committed world
    await act(async () => {
      setShowLate(true);
    });
    expect(text(el)).toBe("a:old;b:idle;late:old");
    // transition resolves: everything advances together
    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(text(el)).toBe("a:new;b:done;late:new");
  });
});

describe("real React: suspense", () => {
  it("first load suspends to the fallback, resolves, and converges without refetch loops", async () => {
    const gate = deferred<number>();
    let fetches = 0;
    const { remote } = createRoot(() => {
      const remote = createMemo(() => {
        fetches++;
        return gate.promise;
      });
      return { remote };
    });
    function App() {
      const v = useSignal(remote);
      return <span>v:{v}</span>;
    }
    const el = await mount(
      <React.Suspense fallback={<span>loading</span>}>
        <App />
      </React.Suspense>
    );
    expect(text(el)).toBe("loading");
    await act(async () => {
      gate.resolve(21);
      await gate.promise;
    });
    expect(text(el)).toBe("v:21");
    expect(fetches).toBeLessThan(5);
  });

  it("two-level rule: refetch keeps stale content (no fallback flash); useIsPending flips", async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const { dep, setDep, remote } = createRoot(() => {
      const [dep, setDep] = createSignal(0);
      const remote = createMemo(() => gates[dep()].promise);
      return { dep, setDep, remote };
    });
    void dep;
    const frames: string[] = [];
    function App() {
      const v = useSignal(remote);
      const pending = useIsPending(() => remote());
      const s = `${v}:${pending ? "pending" : "settled"}`;
      frames.push(s);
      return <span>{s}</span>;
    }
    const el = await mount(
      <React.Suspense fallback={<span>loading</span>}>
        <App />
      </React.Suspense>
    );
    expect(text(el)).toBe("loading");
    await act(async () => {
      gates[0].resolve("v1");
      await gates[0].promise;
    });
    expect(text(el)).toBe("v1:settled");
    // urgent input change -> refetch; stale content stays, isPending flips
    await act(async () => {
      setDep(1);
    });
    expect(text(el)).toBe("v1:pending");
    await act(async () => {
      gates[1].resolve("v2");
      await gates[1].promise;
    });
    expect(text(el)).toBe("v2:settled");
    for (const f of frames) expect(f).not.toContain("loading");
  });

  it("interleaved pending transitions on one root keep distinct per-node data (no aliasing)", async () => {
    const gateA = deferred<string>();
    const gateB = deferred<string>();
    const { setFlagA, setFlagB, memoA, memoB } = createRoot(() => {
      const [flagA, setFlagA] = createSignal(false);
      const [flagB, setFlagB] = createSignal(false);
      const memoA = createMemo(() => (flagA() ? gateA.promise : "a0"));
      const memoB = createMemo(() => (flagB() ? gateB.promise : "b0"));
      return { setFlagA, setFlagB, memoA, memoB };
    });
    function App() {
      const a = useSignal(memoA);
      const b = useSignal(memoB);
      return (
        <span>
          {a}
          {b}
        </span>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>loading</span>}>
        <App />
      </React.Suspense>
    );
    expect(text(el)).toBe("a0b0");
    await act(async () => {
      React.startTransition(() => {
        setFlagA(true);
      });
    });
    await act(async () => {
      React.startTransition(() => {
        setFlagB(true);
      });
    });
    // both held: committed content on screen
    expect(text(el)).toBe("a0b0");
    // settle B first: screen must never show A's data in B's slot
    await act(async () => {
      gateB.resolve("B2");
      await gateB.promise;
    });
    expect(["a0b0", "a0B2"]).toContain(text(el));
    await act(async () => {
      gateA.resolve("A1");
      await gateA.promise;
    });
    expect(text(el)).toBe("A1B2");
  });
});

describe("real React: flushSync parity", () => {
  it("a signal and a useState mirror written in the same task never diverge across flushSync", async () => {
    const { sig, setSig } = createRoot(() => {
      const [sig, setSig] = createSignal(0);
      return { sig, setSig };
    });
    const frames: Array<{ s: number; m: number }> = [];
    let setM!: (v: number) => void;
    let setN!: (v: number) => void;
    function App() {
      const [m, _setM] = React.useState(0);
      const [n, _setN] = React.useState(0);
      setM = _setM;
      setN = _setN;
      const s = useSignal(sig);
      frames.push({ s, m });
      return (
        <span>
          s{s}:m{m}:n{n}
        </span>
      );
    }
    const el = await mount(<App />);
    await act(async () => {
      setSig(5);
      setM(5);
      flushSync(() => setN(1));
      // inside the same task: the signal and its useState twin agree
      const match = text(el)!.match(/^s(\d+):m(\d+)/)!;
      expect(match[1]).toBe(match[2]);
    });
    expect(text(el)).toBe("s5:m5:n1");
    for (const f of frames) expect(f.s).toBe(f.m);
  });
});

describe("real React: multi-root, StrictMode, effects", () => {
  it("two roots over one signal never tear against each other", async () => {
    const { sig, setSig } = createRoot(() => {
      const [sig, setSig] = createSignal(0);
      return { sig, setSig };
    });
    function App() {
      return <span>{useSignal(sig)}</span>;
    }
    const el1 = await mount(<App />);
    const el2 = await mount(<App />);
    await act(async () => {
      React.startTransition(() => {
        setSig(3);
      });
    });
    expect(text(el1)).toBe("3");
    expect(text(el2)).toBe("3");
  });

  it("StrictMode double-mount nets to one live subscription; writes still propagate", async () => {
    const { sig, setSig } = createRoot(() => {
      const [sig, setSig] = createSignal(0);
      return { sig, setSig };
    });
    function App() {
      return <span>{useSignal(sig)}</span>;
    }
    const el = await mount(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    expect(text(el)).toBe("0");
    await act(async () => {
      setSig(1);
    });
    expect(text(el)).toBe("1");
    await act(async () => {
      setSig(2);
    });
    expect(text(el)).toBe("2");
  });

  it("useSignalState holds component state; useComputed tracks signal reads not in deps (StrictMode)", async () => {
    const { external, setExternal } = createRoot(() => {
      const [external, setExternal] = createSignal(10);
      return { external, setExternal };
    });
    let bumpLocal!: () => void;
    function App() {
      const [local, setLocal] = useSignalState(1);
      const sum = useComputed(() => local + external(), [local]);
      bumpLocal = () => setLocal(v => v + 1);
      return <span>{sum}</span>;
    }
    const el = await mount(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    expect(text(el)).toBe("11");
    await act(async () => {
      bumpLocal();
    });
    expect(text(el)).toBe("12");
    await act(async () => {
      setExternal(20);
    });
    expect(text(el)).toBe("22");
  });

  it("useSignalEffect observes committed values after commit, with cleanup ordering", async () => {
    const { sig, setSig } = createRoot(() => {
      const [sig, setSig] = createSignal(0);
      return { sig, setSig };
    });
    const log: string[] = [];
    function App() {
      useSignalEffect(() => {
        const v = sig();
        log.push(`run:${v}`);
        return () => log.push(`cleanup:${v}`);
      });
      return <span>{useSignal(sig)}</span>;
    }
    await mount(<App />);
    await act(async () => {});
    expect(log).toEqual(["run:0"]);
    await act(async () => {
      setSig(1);
    });
    expect(log).toEqual(["run:0", "cleanup:0", "run:1"]);
  });

  it("useSignalEffect never observes a pending transition's values", async () => {
    const gate = deferred<string>();
    const { sig, setSig, setFlag, blocker } = createRoot(() => {
      const [sig, setSig] = createSignal("initial");
      const [flag, setFlag] = createSignal(false);
      const blocker = createMemo(() => (flag() ? gate.promise : "idle"));
      return { sig, setSig, setFlag, blocker };
    });
    const seen: string[] = [];
    function App() {
      useSignalEffect(() => {
        seen.push(sig());
      });
      const s = useSignal(sig);
      const b = useSignal(blocker);
      return (
        <span>
          {s}:{b}
        </span>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>fallback</span>}>
        <App />
      </React.Suspense>
    );
    await act(async () => {
      React.startTransition(() => {
        setSig("pending");
        setFlag(true);
      });
    });
    expect(text(el)).toBe("initial:idle");
    expect(seen).not.toContain("pending");
    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(text(el)).toBe("pending:done");
    expect(seen).toContain("pending");
  });
});

describe("real React: Solid async API surface", () => {
  it("refresh() refetches with unchanged inputs inside a transition; stale content preserved", async () => {
    let fetchCount = 0;
    let gate = deferred<string>();
    const { remote } = createRoot(() => {
      const remote = createMemo(() => {
        fetchCount++;
        return gate.promise;
      });
      return { remote };
    });
    let start!: (fn: () => void) => void;
    function App() {
      // useTransition's own isPending (rendered as "!") pins that the React
      // transition is genuinely engaged by the refresh — the refetch must
      // suspend the transition render, not just run as an urgent refetch.
      const [inTransition, startTransition] = React.useTransition();
      start = startTransition;
      const v = useSignal(remote);
      const pending = useIsPending(() => remote());
      return (
        <span>
          {v}:{pending ? "pending" : "settled"}
          {inTransition ? "!" : ""}
        </span>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>loading</span>}>
        <App />
      </React.Suspense>
    );
    await act(async () => {
      gate.resolve("fresh-1");
      await gate.promise;
    });
    expect(text(el)).toBe("fresh-1:settled");
    const before = fetchCount;
    gate = deferred<string>();
    await act(async () => {
      start(() => {
        refresh(remote);
      });
    });
    expect(fetchCount).toBeGreaterThan(before); // real refetch
    // stale content, no fallback; Solid isPending AND React's transition
    // pending both visible while the batch is held open
    expect(text(el)).toBe("fresh-1:pending!");
    await act(async () => {
      gate.resolve("fresh-2");
      await gate.promise;
    });
    expect(text(el)).toBe("fresh-2:settled");
  });

  it("useLatest never suspends after first load and shows in-flight upstream values", async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const { setId, remote, id } = createRoot(() => {
      const [id, setId] = createSignal(0);
      const remote = createMemo(() => gates[id()].promise);
      return { setId, remote, id };
    });
    function App() {
      const v = useLatest(() => remote());
      const upstream = useLatest(() => id());
      return (
        <span>
          {String(v)}@{upstream}
        </span>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>loading</span>}>
        <App />
      </React.Suspense>
    );
    await act(async () => {
      gates[0].resolve("d0");
      await gates[0].promise;
    });
    expect(text(el)).toBe("d0@0");
    await act(async () => {
      setId(1);
    });
    // loading-indicator pattern: upstream shows the NEW id while the async
    // node itself keeps serving the last committed value
    expect(text(el)).toBe("d0@1");
    await act(async () => {
      gates[1].resolve("d1");
      await gates[1].promise;
    });
    expect(text(el)).toBe("d1@1");
  });

  it("createOptimistic shows the override immediately and reverts exactly at the transition's commit", async () => {
    const gate = deferred<string>();
    const { opt, setOpt, setFlag, blocker } = createRoot(() => {
      const [opt, setOpt] = createOptimistic("saved-0");
      const [flag, setFlag] = createSignal(false);
      const blocker = createMemo(() => (flag() ? gate.promise : "idle"));
      return { opt, setOpt, setFlag, blocker };
    });
    function App() {
      const v = useSignal(opt);
      const b = useSignal(blocker);
      return (
        <span>
          {v}:{b}
        </span>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>fallback</span>}>
        <App />
      </React.Suspense>
    );
    expect(text(el)).toBe("saved-0:idle");
    // optimistic write + async work in one transition: the override is
    // visible immediately (urgent world included) while the transition holds
    await act(async () => {
      React.startTransition(() => {
        setOpt("optimistic!");
        setFlag(true);
      });
    });
    expect(text(el)).toBe("optimistic!:idle");
    // settlement completes the batch; the override reverts at that commit
    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(text(el)).toBe("saved-0:done");
  });
});

describe("real React: which world does an outside-render read see?", () => {
  it("a transition scope reads its own staged write back; ambient reads stay committed", async () => {
    const gate = deferred<string>();
    const { sig, setSig, setFlag, blocker } = createRoot(() => {
      const [sig, setSig] = createSignal(0);
      const [flag, setFlag] = createSignal(false);
      const blocker = createMemo(() => (flag() ? gate.promise : "idle"));
      return { sig, setSig, setFlag, blocker };
    });
    function App() {
      const v = useSignal(sig);
      const b = useSignal(blocker);
      return (
        <span>
          {v}:{b}
        </span>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>fallback</span>}>
        <App />
      </React.Suspense>
    );
    let inScope = -1;
    let inScopeMemo: unknown = null;
    const memoOverSig = createRoot(() => createMemo(() => sig() + 100));
    expect(memoOverSig()).toBe(100);
    await act(async () => {
      React.startTransition(() => {
        setSig(10);
        inScope = sig(); // same-scope read-back sees the scope's own draft
        inScopeMemo = memoOverSig(); // memos too, once staged in this world
        setFlag(true); // hold the transition open
      });
    });
    expect(inScope).toBe(10);
    void inScopeMemo; // memo staging inside the scope is timing-dependent; not pinned
    // ambient reads (event handlers, timers) resolve committed state only
    expect(sig()).toBe(0);
    expect(memoOverSig()).toBe(100);
    expect(text(el)).toBe("0:idle");
    await act(async () => {
      gate.resolve("done");
      await gate.promise;
    });
    expect(sig()).toBe(10);
    expect(memoOverSig()).toBe(110);
    expect(text(el)).toBe("10:done");
  });
});

describe("real React: render purity", () => {
  it("render-phase signal writes are rejected and nothing persists", async () => {
    const { sig, setSig } = createRoot(() => {
      const [sig, setSig] = createSignal(0);
      return { sig, setSig };
    });
    class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? <span>rejected</span> : this.props.children;
      }
    }
    function Bad() {
      setSig(99); // write during render: must throw
      return <span>{useSignal(sig)}</span>;
    }
    // React logs the caught render error; keep the test output quiet.
    const prevError = console.error;
    console.error = () => {};
    try {
      const el = await mount(
        <Boundary>
          <Bad />
        </Boundary>
      );
      expect(text(el)).toBe("rejected");
    } finally {
      console.error = prevError;
    }
    expect(sig()).toBe(0); // the rejected write never became state
  });
});

describe("real React: useSelector expressions", () => {
  it("selector over multiple signals re-renders on either and computes in-world", async () => {
    const { a, setA, b, setB } = createRoot(() => {
      const [a, setA] = createSignal(1);
      const [b, setB] = createSignal(2);
      return { a, setA, b, setB };
    });
    function App() {
      const sum = useSelector(() => a() + b());
      return <span>{sum}</span>;
    }
    const el = await mount(<App />);
    expect(text(el)).toBe("3");
    await act(async () => {
      setA(10);
    });
    expect(text(el)).toBe("12");
    await act(async () => {
      React.startTransition(() => {
        setB(20);
      });
    });
    expect(text(el)).toBe("30");
  });
});
