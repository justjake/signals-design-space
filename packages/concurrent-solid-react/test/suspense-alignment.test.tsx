// @vitest-environment jsdom
/**
 * Pins the React<->Solid suspense/transition alignment questions:
 *
 * 1. `startTransition(() => setReq(promise))` (promise-in-a-signal, unwrapped
 *    by a memo): React holds the transition's UI until the promise settles —
 *    on EVERY round, not just the first load. The engine never holds UI
 *    itself; the transition render suspends (same-world pending read) and
 *    that is what keeps React's transition pending.
 *
 * 2. Finalization alignment: the same promise suspending CompA through
 *    React's own `use()` and CompB through a signal read settles into ONE
 *    commit — signals-transition-finalized == react-transition-finalized.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot as createDomRoot, type Root } from "react-dom/client";
import {
  createMemo,
  createRoot,
  createSignal,
  flush,
  registerConcurrentSolidReact,
  useSignal,
  type BridgeHandle
} from "../src/index.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

let handle: BridgeHandle;
let roots: Array<{ root: Root; el: HTMLElement }> = [];

beforeEach(() => {
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

describe("promise-in-a-signal under startTransition", () => {
  it("React holds the transition every round, not just the first load", async () => {
    const p1 = deferred<string>();
    // The idiom for "setSignal(new Promise(...))": the signal stores the
    // promise as a plain value; the memo returns it, becoming the async
    // source (latest-wins across replacements).
    const { setReq, data } = createRoot(() => {
      const [req, setReq] = createSignal<Promise<string>>(p1.promise);
      const data = createMemo(() => req());
      return { setReq, data };
    });
    let start!: (fn: () => void) => void;
    function App() {
      const [isPending, startTransition] = React.useTransition();
      start = startTransition;
      const v = useSignal(data);
      return (
        <span>
          {v}
          {isPending ? "!" : ""}
        </span>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>loading</span>}>
        <App />
      </React.Suspense>
    );
    // round 1 — first load: nothing committed yet, so suspense = fallback
    expect(text(el)).toBe("loading");
    await act(async () => {
      p1.resolve("v1");
      await p1.promise;
    });
    expect(text(el)).toBe("v1");

    // round 2 — swap the promise inside a transition: React keeps the old
    // UI on screen (no fallback), reports isPending, holds the commit
    const p2 = deferred<string>();
    await act(async () => {
      start(() => {
        setReq(p2.promise);
      });
    });
    // held + useTransition's isPending indicator rendered (the "!"): the DOM
    // is the observer here — the old value stays, no fallback appears
    expect(text(el)).toBe("v1!");
    await act(async () => {
      p2.resolve("v2");
      await p2.promise;
    });
    expect(text(el)).toBe("v2");

    // round 3 — same thing again: holding is not a first-time-only behavior
    const p3 = deferred<string>();
    await act(async () => {
      start(() => {
        setReq(p3.promise);
      });
    });
    expect(text(el)).toBe("v2!");
    await act(async () => {
      p3.resolve("v3");
      await p3.promise;
    });
    expect(text(el)).toBe("v3");
  });
});

describe("cross-layer settlement alignment", () => {
  it("one promise suspending CompA via React.use and CompB via a signal settles in one commit", async () => {
    const p1 = deferred<string>();
    const { setReq, data } = createRoot(() => {
      const [req, setReq] = createSignal<Promise<string>>(p1.promise);
      const data = createMemo(() => req());
      return { setReq, data };
    });
    // CompA consumes the promise through React's own protocol...
    function CompA({ req }: { req: Promise<string> }) {
      const v = (React as any).use(req) as string;
      return <span>A:{v}</span>;
    }
    // ...CompB consumes the SAME promise through the signal graph.
    function CompB() {
      return <span>;B:{useSignal(data)}</span>;
    }
    let setAReq!: (p: Promise<string>) => void;
    let start!: (fn: () => void) => void;
    function App() {
      const [aReq, _setAReq] = React.useState(p1.promise);
      const [, startTransition] = React.useTransition();
      setAReq = _setAReq;
      start = startTransition;
      return (
        <>
          <CompA req={aReq} />
          <CompB />
        </>
      );
    }
    const el = await mount(
      <React.Suspense fallback={<span>loading</span>}>
        <App />
      </React.Suspense>
    );
    expect(text(el)).toBe("loading");
    await act(async () => {
      p1.resolve("x1");
      await p1.promise;
    });
    // both sides reveal together, one commit
    expect(text(el)).toBe("A:x1;B:x1");

    // hand BOTH layers a fresh promise inside one transition
    const p2 = deferred<string>();
    await act(async () => {
      start(() => {
        setAReq(p2.promise); // React path (use)
        setReq(p2.promise); // signal path
      });
    });
    // transition held: neither side moved, no fallback
    expect(text(el)).toBe("A:x1;B:x1");
    await act(async () => {
      p2.resolve("x2");
      await p2.promise;
    });
    // settlement lands in one commit: never A:x2;B:x1 or A:x1;B:x2
    expect(text(el)).toBe("A:x2;B:x2");
  });
});
