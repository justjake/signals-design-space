// @vitest-environment jsdom
/**
 * The real-React gate, continued: scenarios 11, 12, 15, 16, 17, 18.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  atom,
  computed,
  read,
  serializeAtomState,
  initializeAtomState,
  resetEngine,
  startTrace,
  type Atom,
  type Use,
} from 'signals-royale-fx1';
import { refresh } from 'signals-royale-fx1';
import { flushSync } from 'react-dom';
import { useValue, useIsPending, startTransitionWrite, onDomMutation } from '../src/index';
import { makeHarness, deferred, act, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

/** One request per (param, epoch); counts real fetches, caches gates. */
function makeResource(param: Atom<number>) {
  let epoch = 0;
  let fetchCount = 0;
  const gates = new Map<string, ReturnType<typeof deferred<string>>>();
  const data = computed((use: Use) => {
    const key = `${param.get()}:${epoch}`;
    let g = gates.get(key);
    if (g === undefined) {
      g = deferred<string>();
      gates.set(key, g);
      fetchCount++;
    }
    return use(g.promise);
  });
  return {
    data,
    fetchCount: () => fetchCount,
    refetch() {
      epoch++;
      refresh(data);
    },
    async settle(key: string, v: string) {
      const g = gates.get(key);
      if (g === undefined) throw new Error(`no request ${key}: have ${[...gates.keys()]}`);
      await act(async () => {
        g.resolve(v);
        await g.promise;
        await Promise.resolve();
      });
    },
  };
}

describe('scenario 11: suspense family', () => {
  test('first load: fallback then converge; fetch count 1 across retries', async () => {
    const param = atom(0);
    const r = makeResource(param);
    function View() {
      return <span>d:{useValue(r.data)}</span>;
    }
    const { container } = await h.mount(
      <React.Suspense fallback={<i>loading</i>}>
        <View />
      </React.Suspense>,
    );
    expect(h.text(container)).toBe('loading');
    await r.settle('0:0', 'one');
    expect(h.text(container)).toBe('d:one');
    expect(r.fetchCount()).toBe(1);
  });

  test('refresh: stale serves with isPending, no fallback flash; latest-wins on races', async () => {
    const param = atom(0);
    const r = makeResource(param);
    function Probe() {
      return <em>{useIsPending(r.data) ? 'P' : 'i'};</em>;
    }
    function View() {
      return <span>d:{useValue(r.data)}</span>;
    }
    const { container } = await h.mount(
      <>
        <Probe />
        <React.Suspense fallback={<i>loading</i>}>
          <View />
        </React.Suspense>
      </>,
    );
    await r.settle('0:0', 'one');
    expect(h.text(container)).toBe('i;d:one');
    await act(async () => {
      r.refetch();
    });
    expect(h.text(container)).toBe('P;d:one'); // stale + pending, no fallback
    expect(r.fetchCount()).toBe(2);
    // Race: a second refresh before the first settles; the newest wins.
    await act(async () => {
      r.refetch();
    });
    expect(r.fetchCount()).toBe(3);
    await r.settle('0:1', 'stale-answer');
    await r.settle('0:2', 'fresh-answer');
    expect(h.text(container)).toBe('i;d:fresh-answer');
  });

  test('settlement inside a transition commits with the transition', async () => {
    const param = atom(0);
    const r = makeResource(param);
    function View() {
      return <span>d:{useValue(r.data)}</span>;
    }
    const { container } = await h.mount(
      <React.Suspense fallback={<i>loading</i>}>
        <View />
      </React.Suspense>,
    );
    await r.settle('0:0', 'one');
    await act(async () => {
      startTransitionWrite(() => {
        param.set(1);
        r.refetch();
      });
    });
    expect(h.text(container)).toBe('d:one'); // held: stale, no fallback
    await r.settle('1:1', 'TWO');
    expect(h.text(container)).toBe('d:TWO');
  });
});

describe('scenario 12: time slicing', () => {
  test('urgent flushSync lands while a large transition renders', async () => {
    const items = atom(0);
    const urgent = atom(0);
    let itemRenders = 0;
    function SlowItem({ k }: { k: number }) {
      itemRenders++;
      const end = performance.now() + 4;
      while (performance.now() < end) {
        // burn one slice
      }
      return <i>{k},</i>;
    }
    function List() {
      const n = useValue(items);
      const kids = [];
      for (let k = 0; k < n; k++) kids.push(<SlowItem key={k} k={k} />);
      return (
        <div>
          n:{n};{kids}
        </div>
      );
    }
    function Input() {
      return <b>u:{useValue(urgent)};</b>;
    }
    const { container } = await h.mount(
      <>
        <Input />
        <List />
      </>,
    );
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      startTransitionWrite(() => items.set(24));
      const deadline = Date.now() + 5000;
      while (itemRenders < 3 && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 5));
      }
      expect(itemRenders).toBeGreaterThanOrEqual(3);
      expect(itemRenders).toBeLessThan(24); // interruption is real
      flushSync(() => urgent.set(1));
      expect(h.text(container)).toContain('u:1;');
      expect(h.text(container)).toContain('n:0;');
      const done = Date.now() + 15000;
      while (!h.text(container).includes('n:24;') && Date.now() < done) {
        await new Promise((res) => setTimeout(res, 10));
      }
      expect(h.text(container)).toContain('n:24;');
      expect(h.text(container)).toContain('u:1;');
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    }
  }, 30000);
});

describe('scenario 15: causality', () => {
  test('the trace explains urgent and post-retirement re-renders', async () => {
    const tracer = startTrace();
    const a = atom(1, { label: 'a' });
    const hold = atom(false);
    const gate = deferred<void>();
    function App() {
      const v = useValue(a);
      const held = useValue(hold);
      if (held && !gate.settled) throw gate.promise;
      return <span>v:{v}</span>;
    }
    const { container } = await h.mount(
      <React.Suspense fallback={<i>fb</i>}>
        <App />
      </React.Suspense>,
    );
    await act(async () => {
      startTransitionWrite(() => {
        a.update((x) => x + 1);
        hold.set(true);
      });
    });
    await act(async () => {
      a.update((x) => x * 2);
    });
    expect(h.text(container)).toBe('v:2');
    const urgentChain = tracer.whyLastDelivery(a);
    expect(urgentChain.join(' ')).toMatch(/write/i);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(h.text(container)).toBe('v:4');
    const retiredChain = tracer.whyLastDelivery(a);
    expect(retiredChain.join(' ')).toMatch(/retire|write/i);
    // Structure: causes always point at earlier, retained events.
    const events = tracer.events();
    const ids = new Set(events.map((e) => e.id));
    for (const e of events) {
      if (e.cause !== 0) {
        expect(e.cause).toBeLessThan(e.id);
        expect(ids.has(e.cause)).toBe(true);
      }
    }
    tracer.stop();
  });

  test('ring mode: overflow is counted, never silent', () => {
    const tracer = startTrace({ capacity: 16 });
    for (let i = 0; i < 40; i++) tracer.emit('write', 0, `w${i}`);
    expect(tracer.overflow).toBe(40 - 16);
    expect(tracer.events().length).toBe(16);
    tracer.stop();
  });
});

describe('scenario 16: DOM mutation window', () => {
  test('a MutationObserver blinded during the window sees only third-party mutations', async () => {
    const a = atom(0);
    function App() {
      return <span>r:{useValue(a)};</span>;
    }
    const { container } = await h.mount(<App />);
    const leaked: MutationRecord[] = [];
    const mo = new MutationObserver((records) => leaked.push(...records));
    const observe = () =>
      mo.observe(container, { childList: true, characterData: true, subtree: true });
    observe();
    const phases: string[] = [];
    const off = onDomMutation((phase, c) => {
      if (c !== container) return;
      phases.push(phase);
      if (phase === 'start') {
        leaked.push(...mo.takeRecords());
        mo.disconnect();
      } else {
        observe();
      }
    });
    await act(async () => {
      a.set(1);
    });
    leaked.push(...mo.takeRecords());
    expect(h.text(container)).toBe('r:1;');
    expect(leaked).toEqual([]);
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases.length % 2).toBe(0);
    for (let i = 0; i < phases.length; i += 2) {
      expect(phases[i]).toBe('start');
      expect(phases[i + 1]).toBe('stop');
    }
    container.appendChild(document.createElement('div'));
    expect(mo.takeRecords().length).toBeGreaterThan(0);
    mo.disconnect();
    off();
  });
});

describe('scenario 17: lazy initializers', () => {
  test('initializer runs at first render read, once', async () => {
    let runs = 0;
    const a = atom((): number => {
      runs++;
      return 7;
    });
    expect(runs).toBe(0);
    function App() {
      return <span>{useValue(a)}</span>;
    }
    const { container } = await h.mount(<App />);
    expect(h.text(container)).toBe('7');
    expect(runs).toBe(1);
    await act(async () => {
      a.set(8);
    });
    expect(h.text(container)).toBe('8');
    expect(runs).toBe(1);
  });

  test('set before first read runs the initializer first', () => {
    let runs = 0;
    const a = atom((): number => {
      runs++;
      return 1;
    });
    a.set(5);
    expect(runs).toBe(1);
    expect(read(a)).toBe(5);
  });
});

describe('scenario 18: SSR', () => {
  test('serialize, install on a fresh engine, first render exact with zero corrective re-renders', async () => {
    const s1 = atom(1);
    const s2 = atom('x');
    s1.set(5);
    const json = serializeAtomState([s1, s2]);
    resetEngine();
    let initRuns = 0;
    const c1 = atom((): number => {
      initRuns++;
      return 0;
    });
    const c2 = atom('default');
    initializeAtomState(json, [c1, c2]);
    expect(initRuns).toBe(0); // install is not a write and runs no initializer
    let renders = 0;
    function App() {
      renders++;
      return (
        <span>
          {useValue(c1)}:{useValue(c2)}
        </span>
      );
    }
    const { container } = await h.mount(<App />);
    expect(h.text(container)).toBe('5:x');
    expect(renders).toBe(1);
    expect(initRuns).toBe(0);
  });
});
