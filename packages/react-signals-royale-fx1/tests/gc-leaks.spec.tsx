// @vitest-environment jsdom
/**
 * React-side leak audit: unmounts return engine subscriptions to baseline,
 * component-owned atoms are collectable after unmount, and a quiescent
 * runtime holds no per-episode state.
 */
import * as React from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { atom, debugFootprint, type Atom } from 'signals-royale-fx1';
import { useValue, useAtom, startTransitionWrite } from '../src/index';
import { makeHarness, act, type Harness } from './helpers';

declare const gc: () => void;

function gcFromEmptyStack(): Promise<void> {
  return new Promise((res) =>
    setTimeout(() => {
      gc();
      setTimeout(res, 0);
    }, 0),
  );
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

test('mount/unmount cycles return subscriptions to baseline; quiescence holds nothing', async () => {
  const cells = Array.from({ length: 24 }, (_, i) => atom(i));
  function App() {
    return <div>{cells.map((c, i) => (
      <span key={i}>{useValue(c)}</span>
    ))}</div>;
  }
  const { root } = await h.mount(<App />);
  expect(debugFootprint().subs).toBe(24);
  await act(async () => {
    startTransitionWrite(() => {
      for (const c of cells) c.update((x) => x + 1);
    });
  });
  await act(async () => {});
  await act(async () => {
    root.render(null);
  });
  await act(async () => {});
  const footprint = debugFootprint();
  expect(footprint.subs).toBe(0);
  expect(footprint.openEpisodes).toBe(0);
  expect(footprint.passFrames).toBe(0);
  expect(footprint.pendingDeliveries).toBe(0);
  expect(footprint.rootViewEntries).toBe(0);
  expect(footprint.cellsWithHistory).toBe(0);
});

test('a component-owned atom is collectable after unmount', async () => {
  const captured: Array<WeakRef<object>> = [];
  function Owner() {
    const local = useAtom(() => ({ big: new Array(1024).fill(1) }));
    if (captured.length === 0) captured.push(new WeakRef(local));
    return <span>{useValue(local) !== undefined ? 'y' : 'n'}</span>;
  }
  const { root, container } = await h.mount(<Owner />);
  expect(h.text(container)).toBe('y');
  expect(captured[0]!.deref()).toBeDefined();
  await act(async () => {
    root.render(null);
  });
  await act(async () => {});
  for (let i = 0; i < 20 && captured[0]!.deref() !== undefined; i++) {
    await gcFromEmptyStack();
  }
  expect(captured[0]!.deref()).toBeUndefined();
});
