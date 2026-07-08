// @vitest-environment jsdom
/**
 * Regression pins for the issue-1 lockup class: the shared render probe must
 * never be left parked in the dirty heap. A parked probe whose flags a later
 * frame resets defeats deleteFromHeap's guard, and runHeap spins forever on
 * that heap level (observed as "one urgent write wedges the page" with
 * memo-subscribed components). probeRead now reads under
 * REACTIVE_RECOMPUTING_DEPS, which every heap-insertion path skips.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot as createDomRoot, type Root } from "react-dom/client";
import {
  createMemo,
  createRoot,
  createSignal,
  flush,
  registerConcurrentSolidReact,
  useSelector,
  type BridgeHandle
} from "../src/index.js";
import { probeRead } from "../src/reader.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
  handle.dispose();
  flush();
  (React as any).unstable_resetBatchRegistryForTest?.();
});

it("a pull-recompute inside a probe frame never parks the probe in the heap", { timeout: 5000 }, () => {
  const { setS, setU, m } = createRoot(() => {
    const [s, setS] = createSignal(1);
    const [u, setU] = createSignal(0);
    const m = createMemo(() => s() * 2);
    const um = createMemo(() => u());
    void um;
    return { setS, setU, m };
  });
  // A flush resets the heap's mark latch so the next tracked read can mark
  // and pull a dirty memo mid-frame (the insertion-prone path).
  setS(2);
  flush();
  setS(3); // m dirty, unflushed
  expect(probeRead(() => m()).value).toBe(6); // pull-recompute inside the frame
  probeRead(() => 0); // next frame resets probe state
  setU(1); // unrelated write so the flush drains the heap
  flush(); // pre-hardening: spins forever on the parked probe's level
  expect(probeRead(() => m()).value).toBe(6);
});

it("urgent write with memo-subscribed components does not wedge (issue 1)", { timeout: 5000 }, async () => {
  const { setCount, derived } = createRoot(() => {
    const [count, setCount] = createSignal(1);
    const derived = createMemo(() => count() * 2);
    return { setCount, derived };
  });
  function Reader() {
    return <span>{useSelector(() => derived())};</span>;
  }
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createDomRoot(el);
  roots.push({ root, el });
  await act(async () => {
    root.render(
      <>
        <Reader />
        <Reader />
        <Reader />
      </>
    );
  });
  expect(el.textContent).toBe("2;2;2;");
  await act(async () => {
    setCount(2); // urgent, outside any transition
  });
  expect(el.textContent).toBe("4;4;4;");
  await act(async () => {
    setCount(3);
  });
  expect(el.textContent).toBe("6;6;6;");
});
