import { afterEach, expect, test } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { atom, latest, trace } from "signals-royale-sx2";
import {
  onDomMutation,
  reduce,
  register,
  startTransitionWrite,
  useIsPending,
  useValue,
  write,
  type RegistrationHandle,
} from "../src/index";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let handle: RegistrationHandle | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  handle?.dispose();
  root = undefined;
  container = undefined;
  handle = undefined;
});

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  handle = register();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve, settled: false };
}

test("urgent writes and batches produce consistent commits", async () => {
  const left = atom(0);
  const right = atom(0);
  let renders = 0;
  function App() {
    renders++;
    return (
      <span>
        {useValue(left)},{useValue(right)}
      </span>
    );
  }
  const view = await mount(<App />);
  const before = renders;
  await act(async () => {
    write(left, 1);
    write(right, 2);
  });
  expect(view.textContent).toBe("1,2");
  expect(renders).toBe(before + 1);
});

test("a suspended transition stays hidden and rebases over urgent state", async () => {
  const value = atom(1);
  const blocker = atom(0);
  const gate = deferred<void>();
  const tracer = trace();
  function App() {
    const current = useValue(value);
    const blocked = useValue(blocker);
    const pending = useIsPending(value);
    if (blocked === 1 && !gate.settled) throw gate.promise;
    return (
      <span>
        {current}:{String(pending)}
      </span>
    );
  }
  const view = await mount(
    <React.Suspense fallback={<span>fallback</span>}>
      <App />
    </React.Suspense>,
  );
  await act(async () => {
    startTransitionWrite(() => {
      reduce(value, (previous) => previous * 2);
      write(blocker, 1);
    });
  });
  expect(view.textContent).toBe("1:true");
  expect(latest(value)).toBe(2);
  await act(async () => reduce(value, (previous) => previous + 1));
  expect(view.textContent).toBe("2:true");
  expect(tracer.whyLastDelivery(value)[1]).toBe("write [batch 0]");
  gate.settled = true;
  await act(async () => gate.resolve());
  expect(view.textContent).toBe("4:false");
  expect(tracer.whyLastDelivery(value).join(" -> ")).toMatch(
    /component delivery \[batch \d+\] -> write \[batch \d+\] -> batch open/,
  );
  tracer.stop();
});

test("flushSync excludes a live transition draft", async () => {
  const value = atom(0);
  const gate = deferred<void>();
  function App() {
    const current = useValue(value);
    if (current === 1 && !gate.settled) throw gate.promise;
    return <span>{current}</span>;
  }
  const view = await mount(
    <React.Suspense fallback={null}>
      <App />
    </React.Suspense>,
  );
  await act(async () => {
    startTransitionWrite(() => write(value, 1));
  });
  flushSync(() =>
    root?.render(
      <React.Suspense fallback={null}>
        <App />
      </React.Suspense>,
    ),
  );
  expect(view.textContent).toBe("0");
  gate.settled = true;
  await act(async () => gate.resolve());
  expect(view.textContent).toBe("1");
});

test("mutation events exclude React mutations but retain third-party ones", async () => {
  const value = atom(0);
  function App() {
    return <span>{useValue(value)}</span>;
  }
  const view = await mount(<App />);
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((next) => records.push(...next));
  observer.observe(view, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  const stop = onDomMutation((phase, target) => {
    if (target !== view) return;
    if (phase === "start") observer.disconnect();
    else
      observer.observe(view, {
        childList: true,
        subtree: true,
        characterData: true,
      });
  });
  await act(async () => write(value, 1));
  await Promise.resolve();
  expect(records).toHaveLength(0);
  view.append(document.createElement("i"));
  await Promise.resolve();
  expect(records).toHaveLength(1);
  stop();
  observer.disconnect();
});
