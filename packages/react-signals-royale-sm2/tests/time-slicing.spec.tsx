// @vitest-environment jsdom
import { expect, it } from "vitest";
import adapter from "../royale/adapter";

const { React } = adapter;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("interrupts a large transition to commit an urgent input first", async () => {
  adapter.resetForTest();
  const slow = adapter.atom(0);
  const urgent = adapter.atom(0);
  const frames: string[] = [];

  function Item({ index, active }: { index: number; active: boolean }): React.ReactNode {
    let value = index;
    if (active) {
      for (let i = 0; i < 100_000; ++i) value = (value * 33 + i) | 0;
    }
    return <i>{value & 1}</i>;
  }

  function App(): React.ReactNode {
    const slowValue = adapter.useValue(slow);
    const urgentValue = adapter.useValue(urgent);
    React.useLayoutEffect(() => {
      frames.push(`${slowValue}:${urgentValue}`);
    });
    const children: React.ReactNode[] = [];
    const count = slowValue === 0 ? 1 : 1_000;
    for (let i = 0; i < count; ++i)
      children.push(<Item key={i} index={i} active={slowValue !== 0} />);
    return <div>{children}</div>;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = adapter.ReactDOMClient.createRoot(container);
  await adapter.act(async () => root.render(<App />));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  setTimeout(() => adapter.flushSync(() => adapter.set(urgent, 1)), 10);
  adapter.startTransitionWrite(() => adapter.set(slow, 1));
  for (let i = 0; i < 100 && !frames.includes("1:1"); ++i) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const urgentIndex = frames.indexOf("0:1");
  const transitionIndex = frames.indexOf("1:1");
  if (urgentIndex < 0) throw new Error(`frames: ${frames.join(",")}`);
  expect(urgentIndex).toBeGreaterThan(0);
  expect(transitionIndex).toBeGreaterThan(urgentIndex);
  await adapter.act(async () => root.unmount());
  container.remove();
});
