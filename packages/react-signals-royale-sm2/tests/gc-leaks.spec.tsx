// @vitest-environment jsdom
import { expect, it } from "vitest";
import adapter from "../royale/adapter";
import { useAtom } from "../src/index";

const { React } = adapter;
const gc = (globalThis as { gc?: () => void }).gc;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("reclaims a component-owned atom after unmount", async () => {
  expect(gc).toBeTypeOf("function");
  adapter.resetForTest();
  let reference!: WeakRef<object>;
  function View(): React.ReactNode {
    const value = useAtom(1);
    reference = new WeakRef(value);
    return <span>{adapter.useValue(value)}</span>;
  }
  const container = document.createElement("div");
  const root = adapter.ReactDOMClient.createRoot(container);
  await adapter.act(async () => root.render(<View />));
  await adapter.act(async () => root.unmount());
  container.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 100; ++i) {
    const pressure = new Array(10_000);
    pressure.fill(i);
    gc?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(reference.deref()).toBeUndefined();
});
