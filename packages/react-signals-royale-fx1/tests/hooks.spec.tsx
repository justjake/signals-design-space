// @vitest-environment jsdom
/**
 * Hook features: useComputed, useAtom, useSignalEffect, useCommitted,
 * useTransitionWrite, and registration failure.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { atom, read, type Atom } from 'signals-royale-fx1';
import {
  useValue,
  useComputed,
  useAtom,
  useSignalEffect,
  useCommitted,
  useTransitionWrite,
} from '../src/index';
import { makeHarness, deferred, act, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

test('useComputed memoizes on deps and tracks engine reads', async () => {
  const a = atom(2);
  let evals = 0;
  function App({ factor }: { factor: number }) {
    const v = useComputed(() => {
      evals++;
      return a.get() * factor;
    }, [factor]);
    return <span>{v}</span>;
  }
  const { root, container } = await h.mount(<App factor={10} />);
  expect(h.text(container)).toBe('20');
  const before = evals;
  await act(async () => {
    a.set(3);
  });
  expect(h.text(container)).toBe('30');
  expect(evals).toBe(before + 1);
  await act(async () => {
    root.render(<App factor={100} />);
  });
  expect(h.text(container)).toBe('300');
});

test('useAtom owns state per component instance', async () => {
  const setters: Array<(n: number) => void> = [];
  function Counter({ id }: { id: string }) {
    const count = useAtom(0);
    setters.push((n) => count.set(n));
    return (
      <span>
        {id}:{useValue(count)};
      </span>
    );
  }
  const { container } = await h.mount(
    <>
      <Counter id="a" />
      <Counter id="b" />
    </>,
  );
  await act(async () => {
    setters[0]!(5);
  });
  expect(h.text(container)).toBe('a:5;b:0;');
});

test('useSignalEffect re-runs on engine changes with cleanup honored', async () => {
  const a = atom(1);
  const log: string[] = [];
  function App() {
    useSignalEffect(() => {
      const v = read(a);
      log.push(`run:${v}`);
      return () => log.push(`clean:${v}`);
    });
    return null;
  }
  const { root } = await h.mount(<App />);
  await act(async () => {
    a.set(2);
  });
  expect(log).toEqual(['run:1', 'clean:1', 'run:2']);
  await act(async () => {
    root.render(null);
  });
  expect(log).toEqual(['run:1', 'clean:1', 'run:2', 'clean:2']);
});

test('useCommitted tracks the on-screen value, not the draft', async () => {
  const a = atom(0);
  const gate = deferred<void>();
  const committedSeen: number[] = [];
  function Suspender() {
    const v = useValue(a);
    if (v > 0 && !gate.settled) throw gate.promise;
    return <span>s:{v};</span>;
  }
  function CommittedProbe() {
    const v = useCommitted(a) as number;
    committedSeen.push(v);
    return <b>c:{v};</b>;
  }
  const { container } = await h.mount(
    <>
      <CommittedProbe />
      <React.Suspense fallback={null}>
        <Suspender />
      </React.Suspense>
    </>,
  );
  const { startTransitionWrite } = await import('../src/index');
  await act(async () => {
    startTransitionWrite(() => a.set(7));
  });
  expect(h.text(container)).toContain('c:0;'); // draft not on screen
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  expect(h.text(container)).toContain('c:7;');
  expect(committedSeen).not.toContain(7 + 1000); // sanity
});

test('useTransitionWrite reports pending and classifies writes', async () => {
  const a = atom(0);
  const gate = deferred<void>();
  let start!: (scope: () => void) => void;
  const pendingSeen: boolean[] = [];
  function Suspender() {
    const v = useValue(a);
    if (v > 0 && !gate.settled) throw gate.promise;
    return <span>s:{v};</span>;
  }
  function Controls() {
    const [pending, startWrite] = useTransitionWrite();
    start = startWrite;
    pendingSeen.push(pending);
    return <b>{pending ? 'P' : 'i'};</b>;
  }
  const { container } = await h.mount(
    <>
      <Controls />
      <React.Suspense fallback={null}>
        <Suspender />
      </React.Suspense>
    </>,
  );
  await act(async () => {
    start(() => a.set(3));
  });
  expect(h.text(container)).toBe('P;s:0;'); // held: pending reported
  expect(read(a)).toBe(0);
  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  expect(h.text(container)).toBe('i;s:3;');
  expect(read(a)).toBe(3);
  expect(pendingSeen).toContain(true);
});
