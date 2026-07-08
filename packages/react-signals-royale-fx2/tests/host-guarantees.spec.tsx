// @vitest-environment jsdom
/** Host guarantees: loud registration, unmount reclamation, quiescence. */
import { describe, expect, test } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import {
  reactIntegration as engine,
  signal,
  read,
  type Signal,
} from 'signals-royale-fx2';
import { registerReactSignals, startTransitionWrite, useValue } from '../src/index.ts';
import { makeHarness, text } from './helpers.tsx';

function subCount(x: Signal<number>): number {
  let n = 0;
  const node = engine.nodeOf(x) as { subs?: { nextSub?: unknown } };
  for (let l = node.subs as { nextSub?: unknown } | undefined; l !== undefined; l = l.nextSub as never) n++;
  return n;
}

describe('registration', () => {
  test('fails loudly on a React build without the fx2 protocol', () => {
    const g = globalThis as Record<string, unknown>;
    const saved = g.__FX2_REACT_PROTOCOL__;
    delete g.__FX2_REACT_PROTOCOL__;
    try {
      expect(() => registerReactSignals()).toThrow(/fx2 external-state protocol/);
    } finally {
      g.__FX2_REACT_PROTOCOL__ = saved;
    }
    // With the marker restored, registration succeeds and is idempotent.
    const h1 = registerReactSignals();
    const h2 = registerReactSignals();
    expect(h1).toBe(h2);
  });
});

describe('unmount reclamation', () => {
  test('50 readers unmount back to zero subscriptions; transitions quiesce', async () => {
    const h = makeHarness();
    const a = signal(0);
    function Many() {
      const kids = [];
      for (let i = 0; i < 50; i++) kids.push(<Item key={i} />);
      return <>{kids}</>;
    }
    function Item() {
      return <i>{useValue(a)}</i>;
    }
    const { root, container } = await h.mount(<Many />);
    expect(subCount(a)).toBe(50);
    await act(() => {
      startTransitionWrite(() => a.set(1));
    });
    await act(async () => {});
    expect(text(container)).toContain('1');
    expect(engine.liveDraftCount()).toBe(0); // retired at commit: quiescent
    expect(engine.nodeOf(a).worldMemos).toBeNull();
    await act(() => {
      root.render(null);
    });
    expect(subCount(a)).toBe(0); // deterministic unsubscription at unmount
    await h.cleanup();
    expect(h.handle.errors).toEqual([]);
    expect(read(a)).toBe(1);
  });

  test('a full mount/write/transition/unmount cycle leaves no live drafts', async () => {
    const h = makeHarness();
    const a = signal(0);
    function App() {
      return <span>{useValue(a)}</span>;
    }
    const m1 = await h.mount(<App />);
    const m2 = await h.mount(<App />);
    await act(() => {
      startTransitionWrite(() => a.set(5));
    });
    await act(async () => {});
    expect(text(m1.container)).toBe('5');
    expect(text(m2.container)).toBe('5');
    expect(engine.liveDraftCount()).toBe(0);
    await h.cleanup();
    expect(engine.liveDraftCount()).toBe(0);
  });
});
