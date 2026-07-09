// @vitest-environment jsdom
/**
 * The real-React gate: RULES scenarios 1-18 against this package's own fork
 * build, written with raw createRoot + act (no RTL).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, deferred, makeHarness, text, tick, React, type Harness } from './helpers.tsx';
import {
  batch,
  computed,
  isPending as enginePending,
  latest,
  committed,
  read,
  signal,
  update,
  serializeAtomState,
  initializeAtomState,
} from 'signals-royale-fx2';
import {
  startTransitionWrite,
  useIsPending,
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

function Reader({ id, atom }: { id: string; atom: ReturnType<typeof signal<number>> }) {
  return (
    <span>
      {id}:{useValue(atom)};
    </span>
  );
}

describe('scenario 1 — urgent writes commit once', () => {
  test('single write: one re-render; batched writes: one re-render', async () => {
    const a = signal(0);
    const b = signal(0);
    let renders = 0;
    function App() {
      renders++;
      return (
        <span>
          {useValue(a)},{useValue(b)}
        </span>
      );
    }
    const { container } = await h.mount(<App />);
    expect(text(container)).toBe('0,0');
    const before = renders;
    await act(() => {
      a.set(1);
    });
    expect(text(container)).toBe('1,0');
    expect(renders).toBe(before + 1);
    await act(() => {
      batch(() => {
        a.set(7);
        b.set(8);
      });
    });
    expect(text(container)).toBe('7,8');
    expect(renders).toBe(before + 2);
  });
});

describe('scenario 2 — transition invisibility + isPending', () => {
  test('drafts stay out of the committed DOM; the read family agrees; isPending flips', async () => {
    const a = signal(0);
    const hold = signal(false);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      const held = useValue(hold);
      if (held && !gate.settled) throw gate.promise;
      return <b>v:{v};</b>;
    }
    function Probe() {
      return <i>{useIsPending(a) ? 'P' : 'i'};</i>;
    }
    const { container } = await h.mount(
      <>
        <Probe />
        <React.Suspense fallback={<u>fb;</u>}>
          <Suspender />
        </React.Suspense>
      </>,
    );
    expect(text(container)).toBe('i;v:0;');
    await act(() => {
      startTransitionWrite(() => {
        a.set(1);
        hold.set(true);
      });
    });
    expect(text(container)).toBe('P;v:0;'); // held: no leak, no fallback, probe flipped
    expect(read(a)).toBe(0);
    expect(committed(a)).toBe(0);
    expect(latest(a)).toBe(1);
    expect(enginePending(a)).toBe(true);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(container)).toBe('i;v:1;');
    expect(read(a)).toBe(1);
  });
});

describe('scenarios 3 + 13 — urgent-during-transition rebases by replay', () => {
  test('(1+1)*2 = 4: urgent commits alone, retirement lands rebased', async () => {
    const a = signal(1);
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
    expect(text(container)).toBe('v:1');
    await act(() => {
      update(a, (x) => x * 2);
    });
    expect(text(container)).toBe('v:2');
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(container)).toBe('v:4');
    expect(read(a)).toBe(4);
  });

  test('branch state: +2 pending, urgent double: 1 -> 2 -> 6, never 3 or 4', async () => {
    const a = signal(1);
    const hold = signal(false);
    const gate = deferred<void>();
    const seen: number[] = [];
    function Value() {
      const v = useValue(a);
      React.useLayoutEffect(() => {
        seen.push(v);
      });
      return <span>v:{v};</span>;
    }
    function Holder() {
      const held = useValue(hold);
      if (held && !gate.settled) throw gate.promise;
      return null;
    }
    const { container } = await h.mount(
      <>
        <Value />
        <React.Suspense fallback={null}>
          <Holder />
        </React.Suspense>
      </>,
    );
    await act(() => {
      startTransitionWrite(() => {
        update(a, (x) => x + 2);
        hold.set(true);
      });
    });
    await act(() => {
      update(a, (x) => x * 2);
    });
    expect(text(container)).toBe('v:2;');
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(container)).toBe('v:6;');
    expect(seen).not.toContain(3);
    expect(seen).not.toContain(4);
  });
});

describe('the latest() context rule', () => {
  // With a transition draft held over canonical state, each context must
  // resolve its OWN world: the transition's render sees the draft, an
  // urgent render body does not, a canonical computed evaluation resolves
  // canonical (and stays live — the read is tracked), and ambient code sees
  // newest intent. Reading ahead of your world is a tear.
  test('urgent bodies, canonical computeds, the transition render, and ambient code', async () => {
    const a = signal(1);
    const b = signal(0); // unrelated urgent driver
    const hold = signal(false);
    const gate = deferred<void>();
    const viaComputed = computed(() => latest(a) * 100);
    // Every render of the probe records what its subscription resolved next
    // to what a plain latest(a) call in the body resolved. While the draft
    // is held the pair must agree: the transition's passes see 2, urgent
    // passes see 1 — whichever order React runs them in. (The probe
    // subscribes to the drafted cell so the transition's targeted wake
    // renders it; unsubscribed components no longer render in those passes.)
    let held = false;
    const samples: Array<{ v: number; l: number }> = [];

    function UrgentProbe() {
      const n = useValue(b);
      const v = useValue(a);
      if (held) samples.push({ v, l: latest(a) });
      return <b>u:{n};</b>;
    }
    function TransitionReader() {
      const v = useValue(a);
      const holding = useValue(hold);
      if (holding && !gate.settled) throw gate.promise;
      return <span>t:{v};</span>;
    }
    const { container } = await h.mount(
      <React.Suspense fallback={<i>fb</i>}>
        <UrgentProbe />
        <TransitionReader />
      </React.Suspense>,
    );
    expect(text(container)).toBe('u:0;t:1;');
    expect(read(viaComputed)).toBe(100);

    held = true;
    await act(() => {
      startTransitionWrite(() => {
        a.set(2);
        hold.set(true);
      });
    });
    expect(text(container)).toBe('u:0;t:1;'); // held: committed DOM unchanged
    expect(latest(a)).toBe(2); // ambient: newest intent
    expect(read(a)).toBe(1); // canonical read: drafts hidden
    expect(read(viaComputed)).toBe(100); // canonical computed evaluation: canonical
    const draftPasses = samples.filter((s) => s.v === 2);
    expect(draftPasses.length).toBeGreaterThan(0);
    expect(draftPasses.every((s) => s.l === 2)).toBe(true); // the transition's render sees its draft

    await act(() => b.set(1));
    expect(text(container)).toBe('u:1;t:1;');
    const urgentPasses = samples.filter((s) => s.v === 1);
    expect(urgentPasses.length).toBeGreaterThan(0);
    expect(urgentPasses.every((s) => s.l === 1)).toBe(true); // urgent bodies never see the draft
    expect(latest(a)).toBe(2); // ambient still sees the draft after that urgent pass
    expect(read(viaComputed)).toBe(100);
    held = false;

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(container)).toBe('u:1;t:2;');
    expect(read(a)).toBe(2);
    expect(read(viaComputed)).toBe(200); // tracked: the fold re-ran it
    expect(latest(a)).toBe(2);
  });
});

describe('scenario 4 — sibling consistency', () => {
  test('paired reads agree in every render pass, transitions included', async () => {
    const a = signal(0);
    const pairs: Array<[number, number]> = [];
    function Pair() {
      const v1 = useValue(a);
      const v2 = useValue(a);
      pairs.push([v1, v2]);
      return (
        <span>
          {v1},{v2};
        </span>
      );
    }
    const { container } = await h.mount(
      <>
        <Pair />
        <Pair />
      </>,
    );
    await act(() => {
      a.set(1);
      startTransitionWrite(() => a.set(2));
    });
    await act(async () => {});
    expect(text(container)).toBe('2,2;2,2;');
    for (const [v1, v2] of pairs) expect(v1).toBe(v2);
  });
});

describe('scenario 5 — mount mid-transition', () => {
  test('the late mount shows committed state, then joins the transition commit', async () => {
    const a = signal(0);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      if (v > 0 && !gate.settled) throw gate.promise;
      return <span>s:{v};</span>;
    }
    function App({ extra }: { extra: boolean }) {
      return (
        <>
          <Reader id="r1" atom={a} />
          <React.Suspense fallback={<span>fb;</span>}>
            <Suspender />
          </React.Suspense>
          {extra ? <Reader id="r2" atom={a} /> : null}
        </>
      );
    }
    const { root, container } = await h.mount(<App extra={false} />);
    await act(() => {
      startTransitionWrite(() => a.set(1));
    });
    expect(text(container)).toBe('r1:0;s:0;');
    await act(() => {
      root.render(<App extra={true} />);
    });
    expect(text(container)).toBe('r1:0;s:0;r2:0;'); // committed world only
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(container)).toBe('r1:1;s:1;r2:1;'); // one world at retirement
  });
});

describe('scenario 6 — flushSync excludes deferred work', () => {
  test('a flushSync urgent write commits without the pending transition', async () => {
    const { flushSync } = await import('react-dom');
    const a = signal(0);
    const b = signal(0);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      if (v > 0 && !gate.settled) throw gate.promise;
      return <span>s:{v};</span>;
    }
    const { container } = await h.mount(
      <>
        <Reader id="a" atom={a} />
        <Reader id="b" atom={b} />
        <React.Suspense fallback={null}>
          <Suspender />
        </React.Suspense>
      </>,
    );
    await act(() => {
      startTransitionWrite(() => a.set(9));
    });
    await act(() => {
      flushSync(() => b.set(1));
      expect(text(container)).toBe('a:0;b:1;s:0;');
    });
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(container)).toBe('a:9;b:1;s:9;');
  });
});

describe('scenario 7 — one transition across two roots', () => {
  test('per-root committed views diverge while one root holds, then join', async () => {
    const a = signal(0);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      if (v > 0 && !gate.settled) throw gate.promise;
      return <span>s:{v};</span>;
    }
    const one = await h.mount(
      <React.Suspense fallback={null}>
        <Suspender />
      </React.Suspense>,
    );
    const two = await h.mount(<Reader id="r" atom={a} />);
    await act(() => {
      startTransitionWrite(() => a.set(1));
    });
    expect(text(one.container)).toBe('s:0;'); // held here
    expect(text(two.container)).toBe('r:1;'); // committed there
    expect(committed(a, one.container)).toBe(0);
    expect(committed(a, two.container)).toBe(1);
    expect(read(a)).toBe(0); // canonical folds only when every root commits
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(one.container)).toBe('s:1;');
    expect(committed(a, one.container)).toBe(1);
    expect(read(a)).toBe(1);
  });
});

describe('silent folds must repair subscribers the render-pass worlds never reached', () => {
  // A retirement is silent (no subscription-epoch bump) because render-pass
  // worlds already delivered the draft's values to every subscriber. That
  // premise only holds for subscribers whose root carried the draft. The two
  // shapes below never carried it, so the fold is their ONLY delivery
  // channel — they must converge, not stay stale until the next write.
  test('a subscriber outside any SignalScope converges when a transition retires via a scoped root', async () => {
    const { createRoot } = await import('react-dom/client');
    const a = signal(1);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      if (v === 2 && !gate.settled) throw gate.promise;
      return <span>s:{v};</span>;
    }
    const scoped = await h.mount(
      <React.Suspense fallback={<i>fb</i>}>
        <Suspender />
      </React.Suspense>,
    );
    const bareContainer = document.createElement('div');
    document.body.appendChild(bareContainer);
    h.containers.push(bareContainer);
    const bareRoot = createRoot(bareContainer); // deliberately NO SignalScope
    function Bare() {
      return <b>b:{useValue(a)};</b>;
    }
    await act(() => bareRoot.render(<Bare />));
    expect(text(bareContainer)).toBe('b:1;');
    await act(() => {
      startTransitionWrite(() => a.set(2));
    });
    // Held by the scoped root; canonical unchanged, so the bare root shows 1.
    expect(text(scoped.container)).toBe('s:1;');
    expect(text(bareContainer)).toBe('b:1;');
    expect(read(a)).toBe(1);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(scoped.container)).toBe('s:2;');
    expect(read(a)).toBe(2);
    expect(text(bareContainer)).toBe('b:2;'); // repaired by the fold itself
    await act(() => bareRoot.unmount());
  });

  test('a scope mounted mid-transition (never dispatched the draft) converges at retirement', async () => {
    const a = signal(1);
    const gate = deferred<void>();
    function Suspender() {
      const v = useValue(a);
      if (v === 2 && !gate.settled) throw gate.promise;
      return <span>s:{v};</span>;
    }
    const first = await h.mount(
      <React.Suspense fallback={<i>fb</i>}>
        <Suspender />
      </React.Suspense>,
    );
    await act(() => {
      startTransitionWrite(() => a.set(2));
    });
    expect(text(first.container)).toBe('s:1;');
    // This root registers after the draft's dispatch: its passes never carry
    // the draft, so it renders the committed world only.
    const late = await h.mount(<Reader id="r" atom={a} />);
    expect(text(late.container)).toBe('r:1;');
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(text(first.container)).toBe('s:2;');
    expect(text(late.container)).toBe('r:2;'); // the fold was loud for it
  });
});

describe('scenario 8 — StrictMode nets one subscription and one observation', () => {
  test('double-mount: one observe; writes deliver; unmount cleans up once', async () => {
    const log: string[] = [];
    const a = signal(0);
    const observed = signal(0, {
      onObserved: () => {
        log.push('observe');
        return () => log.push('unobserve');
      },
    });
    function App() {
      return (
        <span>
          {useValue(a)}:{useValue(observed)}
        </span>
      );
    }
    const { root, container } = await h.mount(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
    await act(async () => {});
    expect(log).toEqual(['observe']);
    await act(() => {
      a.set(2);
    });
    expect(text(container)).toBe('2:0');
    await act(() => {
      root.render(null);
    });
    await act(async () => {});
    expect(log).toEqual(['observe', 'unobserve']);
  });
});

describe('scenario 9 — unmount: silence and baseline', () => {
  test('no deliveries after unmount; lifetime observation released', async () => {
    const log: string[] = [];
    const a = signal(0, {
      onObserved: () => {
        log.push('observe');
        return () => log.push('unobserve');
      },
    });
    let renders = 0;
    function View() {
      renders++;
      return <span>{useValue(a)}</span>;
    }
    const { root } = await h.mount(<View />);
    await act(async () => {});
    expect(log).toEqual(['observe']);
    await act(() => {
      root.render(<div />);
    });
    await act(async () => {});
    expect(log).toEqual(['observe', 'unobserve']);
    const before = renders;
    await act(() => {
      a.set(1);
      startTransitionWrite(() => a.set(2));
    });
    await act(async () => {});
    expect(renders).toBe(before);
    expect(read(a)).toBe(2); // the transition still landed in the engine
  });
});

describe('scenario 10 — write-during-render fails loudly', () => {
  test('set() from a component body throws synchronously', async () => {
    const a = signal(0);
    let thrown: unknown;
    function Bad() {
      const v = useValue(a);
      if (v === 0) {
        try {
          a.set(1);
        } catch (e) {
          thrown = e;
        }
      }
      return <span>{v}</span>;
    }
    const { container } = await h.mount(<Bad />);
    expect(String(thrown)).toMatch(/render/i);
    expect(text(container)).toBe('0');
  });
});

describe('scenario 12 — time slicing stays real', () => {
  test('urgent flushSync lands while a large transition renders', async () => {
    const { flushSync } = await import('react-dom');
    const items = signal(0);
    const urgent = signal(0);
    let itemRenders = 0;
    function SlowItem({ k }: { k: number }) {
      itemRenders++;
      const end = performance.now() + 4;
      while (performance.now() < end) {
        /* burn a slice */
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
      while (itemRenders < 3 && Date.now() < deadline) await tick(5);
      expect(itemRenders).toBeGreaterThanOrEqual(3);
      expect(itemRenders).toBeLessThan(24);
      flushSync(() => urgent.set(1));
      expect(text(container)).toContain('u:1;');
      expect(text(container)).toContain('n:0;');
      const done = Date.now() + 15000;
      while (!text(container).includes('n:24;') && Date.now() < done) await tick(10);
      expect(text(container)).toContain('n:24;');
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    }
  }, 30000);
});
