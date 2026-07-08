/** @vitest-environment jsdom */
import React, { StrictMode, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  atom,
  batch,
  onDomMutation,
  read,
  resetForTest,
  set,
  startTransitionWrite,
  update,
  useIsPending,
  useValue,
} from '../src';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => { resetForTest(); });
afterEach(async () => {
  await React.act(() => { for (const root of roots) root.unmount(); });
  roots = [];
});

describe('real React protocol', () => {
  test('urgent and batched writes each produce one commit', async () => {
    const value = atom(0);
    const commits: number[] = [];
    function App() {
      const current = useValue(value);
      useLayoutEffect(() => { commits.push(current); });
      return <span>{current}</span>;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    await React.act(() => set(value, 1));
    await React.act(() => batch(() => { set(value, 2); set(value, 3); }));
    expect(container.textContent).toBe('3');
    expect(commits).toEqual([0, 1, 3]);
  });

  test('urgent work commits while a transition is suspended, then rebases', async () => {
    const value = atom(1);
    let setSlow!: (value: boolean) => void;
    let resolve!: () => void;
    let ready = false;
    const gate = new Promise<void>(done => { resolve = () => { ready = true; done(); }; });
    function App() {
      const current = useValue(value);
      const pending = useIsPending(value);
      const [slow, changeSlow] = useState(false);
      setSlow = changeSlow;
      if (slow && !ready) throw gate;
      return <span>{current}:{pending ? 'pending' : 'idle'}</span>;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    React.act(() => {
      startTransitionWrite(() => { update(value, x => x * 2); setSlow(true); });
    });
    await React.act(() => update(value, x => x + 1));
    expect(container.textContent).toBe('2:pending');
    await React.act(async () => { resolve(); await gate; });
    expect(container.textContent).toBe('4:idle');
  });

  test('siblings read one transition world', async () => {
    const value = atom(0);
    const seen: string[] = [];
    function Reader() { return <>{useValue(value)}</>; }
    function App() {
      useLayoutEffect(() => { seen.push(document.body.textContent ?? ''); });
      return <><Reader />/<Reader /></>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    await React.act(() => startTransitionWrite(() => set(value, 1)));
    expect(container.textContent).toBe('1/1');
    expect(seen.every(text => !text.includes('0/1') && !text.includes('1/0'))).toBe(true);
    container.remove();
  });

  test('StrictMode nets one lifetime observation', async () => {
    const starts = vi.fn();
    const stops = vi.fn();
    const value = atom(0, { effect: () => { starts(); return stops; } });
    function App() { return <>{useValue(value)}</>; }
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    await React.act(async () => { root.render(<StrictMode><App /></StrictMode>); await Promise.resolve(); });
    expect(starts).toHaveBeenCalledTimes(1);
    await React.act(async () => { root.render(null); await Promise.resolve(); });
    expect(stops).toHaveBeenCalledTimes(1);
  });

  test('mutation events let an observer ignore React writes', async () => {
    const value = atom('a');
    function App() { return <span>{useValue(value)}</span>; }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver(items => records.push(...items));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    const stop = onDomMutation(phase => {
      if (phase === 'start') observer.disconnect();
      else observer.observe(container, { childList: true, subtree: true, characterData: true });
    });
    await React.act(() => root.render(<App />));
    await React.act(() => set(value, 'b'));
    container.append(document.createElement('i'));
    await Promise.resolve();
    expect(records).toHaveLength(1);
    expect(records[0].addedNodes[0].nodeName).toBe('I');
    stop();
    observer.disconnect();
    container.remove();
  });

  test('lazy initialization happens at the first render read', async () => {
    const initialize = vi.fn(() => 5);
    const value = atom(initialize);
    expect(initialize).not.toHaveBeenCalled();
    function App() { return <>{useValue(value)}</>; }
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    await React.act(() => root.render(<App />));
    expect(initialize).toHaveBeenCalledOnce();
    expect(read(value)).toBe(5);
  });
});
