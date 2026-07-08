// @vitest-environment jsdom
/** Scenarios 11, 14-18, plus fx2-specific surfaces (ambient transitions,
 * useSignalTransition, useCommitted, useAtom, useComputed, useSignalEffect). */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, deferred, makeHarness, text, tick, React, type Harness } from './helpers.tsx';
import {
  attachTracer,
  computed,
  nodeOf,
  read,
  refresh,
  serializeAtomState,
  initializeAtomState,
  signal,
  update,
  type Signal,
} from 'signals-royale-fx2';
import {
  onDomMutation,
  startTransitionWrite,
  useAtom,
  useCommitted,
  useComputed,
  useIsPending,
  useSignalEffect,
  useSignalTransition,
  useValue,
} from '../src/index.ts';

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  const errors = [...h.handle.errors];
  await h.cleanup();
  expect(errors).toEqual([]);
});

describe('scenario 11 — suspense family', () => {
  function makeResource(param: Signal<number>) {
    let epoch = 0;
    let fetchCount = 0;
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const data = computed((use) => {
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
      refresh() {
        epoch++;
        refresh(data);
      },
      async settle(key: string, v: string) {
        await act(async () => {
          gates.get(key)!.resolve(v);
          await gates.get(key)!.promise;
          await Promise.resolve();
        });
      },
    };
  }

  function DataView({ data }: { data: unknown }) {
    return <span>d:{useValue(data as never)}</span>;
  }

  test('first load: fallback then converge; one fetch across retries', async () => {
    const param = signal(0);
    const r = makeResource(param);
    const { container } = await h.mount(
      <React.Suspense fallback={<i>loading</i>}>
        <DataView data={r.data} />
      </React.Suspense>,
    );
    expect(text(container)).toBe('loading');
    await r.settle('0:0', 'one');
    expect(text(container)).toBe('d:one');
    expect(r.fetchCount()).toBe(1);
  });

  test('refresh: stale + isPending, never the fallback', async () => {
    const param = signal(0);
    const r = makeResource(param);
    function Probe() {
      return <em>{useIsPending(r.data) ? 'P' : 'i'};</em>;
    }
    const { container } = await h.mount(
      <>
        <Probe />
        <React.Suspense fallback={<i>loading</i>}>
          <DataView data={r.data} />
        </React.Suspense>
      </>,
    );
    await r.settle('0:0', 'one');
    expect(text(container)).toBe('i;d:one');
    await act(() => {
      r.refresh();
    });
    expect(text(container)).toBe('P;d:one');
    expect(r.fetchCount()).toBe(2);
    await r.settle('0:1', 'two');
    expect(text(container)).toBe('i;d:two');
  });

  test('refresh inside a transition, inputs unchanged: useIsPending flips while stale serves', async () => {
    const param = signal(0);
    const r = makeResource(param);
    function Probe() {
      return <em>{useIsPending(r.data) ? 'P' : 'i'};</em>;
    }
    const { container } = await h.mount(
      <>
        <Probe />
        <React.Suspense fallback={<i>loading</i>}>
          <DataView data={r.data} />
        </React.Suspense>
      </>,
    );
    await r.settle('0:0', 'one');
    expect(text(container)).toBe('i;d:one');
    await act(() => {
      startTransitionWrite(() => {
        r.refresh(); // param unchanged: the hidden nonce is the only signal
      });
    });
    expect(r.fetchCount()).toBe(2); // the transition's world refetched
    expect(read(r.data)).toBe('one'); // canonical still serves stale
    // The transition parks on the refetch; the committed screen must show
    // the stale value WITH the pending indicator engaged — the nonce draft
    // has to reach the probe's subscription like any other drafted input.
    expect(text(container)).toBe('P;d:one');
    await r.settle('0:1', 'two');
    expect(text(container)).toBe('i;d:two'); // the refetch commits with the transition
    expect(r.fetchCount()).toBe(2);
  });

  test('settlement inside a transition commits with the transition', async () => {
    const param = signal(0);
    const r = makeResource(param);
    const { container } = await h.mount(
      <React.Suspense fallback={<i>loading</i>}>
        <DataView data={r.data} />
      </React.Suspense>,
    );
    await r.settle('0:0', 'one');
    await act(() => {
      startTransitionWrite(() => {
        param.set(1);
        r.refresh();
      });
    });
    expect(text(container)).toBe('d:one'); // transition holds on the fetch
    await r.settle('1:1', 'TWO');
    expect(text(container)).toBe('d:TWO'); // lands with the transition
    expect(read(r.data)).toBe('TWO');
  });
});

describe('scenario 14 — lifetime effects across subscriber kinds', () => {
  test('React subscribers mount one observation; ctx.set feeds the UI', async () => {
    const log: string[] = [];
    const a = signal(0, {
      onObserved: (ctx) => {
        log.push(`observe:${ctx.get()}`);
        ctx.set(42);
        return () => log.push('unobserve');
      },
    });
    function Sub({ id }: { id: string }) {
      return (
        <span>
          {id}:{useValue(a)};
        </span>
      );
    }
    function App({ n }: { n: number }) {
      return (
        <>
          {n >= 1 ? <Sub id="A" /> : null}
          {n >= 2 ? <Sub id="B" /> : null}
        </>
      );
    }
    const { root, container } = await h.mount(<App n={2} />);
    await act(async () => {});
    expect(log).toEqual(['observe:0']);
    expect(text(container)).toBe('A:42;B:42;');
    await act(() => {
      root.render(<App n={1} />);
    });
    await act(async () => {});
    expect(log).toEqual(['observe:0']);
    await act(() => {
      root.render(<App n={0} />);
    });
    await act(async () => {});
    expect(log).toEqual(['observe:0', 'unobserve']);
  });
});

describe('scenario 15 — causality traces', () => {
  test('urgent chain reaches the write; post-retirement chain passes the retirement', async () => {
    const t = attachTracer();
    const a = signal(1, { label: 'a' });
    const hold = signal(false);
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
    await act(() => {
      startTransitionWrite(() => {
        update(a, (x) => x + 1);
        hold.set(true);
      });
    });
    await act(() => {
      update(a, (x) => x * 2);
    });
    expect(text(container)).toBe('v:2');
    const urgentChain = t.whyLastDelivery(nodeOf(a));
    expect(urgentChain.join(' ')).toMatch(/write/i);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(container)).toBe('v:4');
    const retiredChain = t.whyLastDelivery(nodeOf(a));
    expect(retiredChain.join(' ')).toMatch(/retire|write/i);
    // Structure: causes always reference earlier events.
    for (const e of t.events()) {
      if (e.cause !== 0) expect(e.cause).toBeLessThan(e.id);
    }
    t.stop();
  });
});

describe('scenario 16 — the DOM mutation window', () => {
  test('an observer blinded during the window sees zero React mutations', async () => {
    const a = signal(0);
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
      phases.push(`${phase}:${c === container ? 'here' : 'other'}`);
      if (phase === 'start') {
        leaked.push(...mo.takeRecords());
        mo.disconnect();
      } else {
        observe();
      }
    });
    await act(() => {
      a.set(1);
    });
    leaked.push(...mo.takeRecords());
    expect(text(container)).toBe('r:1;');
    expect(leaked).toEqual([]);
    const here = phases.filter((p) => p.endsWith(':here'));
    expect(here.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < here.length; i += 2) {
      expect(here[i]).toBe('start:here');
      expect(here[i + 1]).toBe('stop:here');
    }
    container.appendChild(document.createElement('div'));
    expect(mo.takeRecords().length).toBeGreaterThan(0); // third-party still seen
    mo.disconnect();
    off();
  });
});

describe('scenario 17 — lazy initializers under React', () => {
  test('initializer runs at first render read, once', async () => {
    let runs = 0;
    const a = signal((): number => {
      runs++;
      return 7;
    });
    function App() {
      return <span>{useValue(a)}</span>;
    }
    expect(runs).toBe(0);
    const { container } = await h.mount(<App />);
    expect(text(container)).toBe('7');
    expect(runs).toBe(1);
    await act(() => {
      a.set(8);
    });
    expect(text(container)).toBe('8');
    expect(runs).toBe(1);
  });
});

describe('scenario 18 — SSR', () => {
  // The fork build script emits client bundles only (no react-dom/server),
  // so the server half is exercised at the engine level: commit values on
  // the "server" engine, serialize under app keys, install client-side.
  test('serialize -> install on fresh atoms -> exact first client render', async () => {
    const s1 = signal(1);
    const s2 = signal('x');
    s1.set(5);
    const json = serializeAtomState([s1, s2]);
    // "Client": fresh atoms; install skips initializers, is not a write.
    let initRuns = 0;
    const c1 = signal((): number => {
      initRuns++;
      return 0;
    });
    const c2 = signal('default');
    initializeAtomState(json, [c1, c2]);
    expect(initRuns).toBe(0);
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
    expect(text(container)).toBe('5:x');
    expect(renders).toBe(1);
    expect(initRuns).toBe(0);
  });
});

describe('fx2 extras', () => {
  test('plain React.startTransition writes classify ambiently (no helper needed)', async () => {
    const a = signal(0);
    const hold = signal(false);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      const held = useValue(hold);
      if (held && !gate.settled) throw gate.promise;
      return <b>v:{v};</b>;
    }
    const { container } = await h.mount(
      <React.Suspense fallback={<i>fb;</i>}>
        <Suspender />
      </React.Suspense>,
    );
    await act(() => {
      React.startTransition(() => {
        a.set(1); // no helper: the ambient classifier opens the draft
        hold.set(true);
      });
    });
    expect(text(container)).toBe('v:0;'); // invisible, held, no fallback
    expect(read(a)).toBe(0);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(container)).toBe('v:1;');
    expect(read(a)).toBe(1);
  });

  test('useSignalTransition: isPending spans the batch lifetime', async () => {
    const a = signal(0);
    const hold = signal(false);
    const gate = deferred<void>();
    let start!: (scope: () => void) => void;
    const pendingSeen: boolean[] = [];
    function Controls() {
      const [isPending, startFn] = useSignalTransition();
      start = startFn;
      pendingSeen.push(isPending);
      return <i>{isPending ? 'P' : 'i'};</i>;
    }
    function Suspender() {
      const v = useValue(a);
      const held = useValue(hold);
      if (held && !gate.settled) throw gate.promise;
      return <b>v:{v};</b>;
    }
    const { container } = await h.mount(
      <>
        <Controls />
        <React.Suspense fallback={null}>
          <Suspender />
        </React.Suspense>
      </>,
    );
    await act(() => {
      start(() => {
        a.set(1);
        hold.set(true);
      });
    });
    expect(text(container)).toBe('P;v:0;');
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(container)).toBe('i;v:1;');
    expect(pendingSeen).toContain(true);
  });

  test('useCommitted tracks this root screen, urgent and transitional', async () => {
    const a = signal(0);
    function App() {
      const now = useValue(a);
      const shown = useCommitted(a);
      return (
        <span>
          n:{now};c:{shown};
        </span>
      );
    }
    const { container } = await h.mount(<App />);
    expect(text(container)).toBe('n:0;c:0;');
    await act(() => {
      a.set(1);
    });
    expect(text(container)).toBe('n:1;c:1;');
    await act(() => {
      startTransitionWrite(() => a.set(2));
    });
    await act(async () => {});
    expect(text(container)).toBe('n:2;c:2;');
  });

  test('useAtom is component-owned; useComputed derives; useSignalEffect observes commits', async () => {
    const base = signal(2);
    const effectSeen: number[] = [];
    function App() {
      const own = useAtom(10);
      const sum = useComputed(() => base.get() + own.get(), [own]);
      useSignalEffect(() => {
        effectSeen.push(base.get());
      });
      return (
        <span>
          s:{sum};o:{useValue(own)};
        </span>
      );
    }
    const { container } = await h.mount(<App />);
    expect(text(container)).toBe('s:12;o:10;');
    await act(() => {
      base.set(3);
    });
    expect(text(container)).toBe('s:13;o:10;');
    expect(effectSeen).toEqual([2, 3]);
  });
});
