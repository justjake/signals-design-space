/** Async semantics: pending/error as graph state, suspensions, refresh. */
import { describe, expect, test } from 'vitest';
import {
  computed,
  effect,
  isPending,
  latest,
  reactIntegration as ri,
  read,
  refresh,
  signal,
} from '../src/index.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r));

describe('pending as graph state', () => {
  test('never-settled read throws a stable thenable; settlement converges', async () => {
    const gate = deferred<string>();
    const c = computed((use) => use(gate.promise));
    let thrown1: unknown;
    let thrown2: unknown;
    try {
      read(c);
    } catch (e) {
      thrown1 = e;
    }
    try {
      read(c);
    } catch (e) {
      thrown2 = e;
    }
    expect(typeof (thrown1 as PromiseLike<void>).then).toBe('function');
    expect(thrown1).toBe(thrown2); // stable suspension thenable across retries
    expect(isPending(c)).toBe(true);
    gate.resolve('done');
    await tick();
    expect(read(c)).toBe('done');
    expect(isPending(c)).toBe(false);
  });

  test('stale value keeps serving while a refetch is pending; latest never suspends', async () => {
    const gates = [deferred<number>(), deferred<number>()];
    let epoch = 0;
    const c = computed((use) => use(gates[epoch].promise));
    gates[0].resolve(1);
    try {
      read(c); // first touch attaches to the (already resolved) thenable
    } catch {
      /* parks until the settlement microtask */
    }
    await tick();
    expect(read(c)).toBe(1);
    epoch = 1;
    refresh(c);
    expect(read(c)).toBe(1); // stale serves
    expect(latest(c)).toBe(1);
    expect(isPending(c)).toBe(true);
    gates[1].resolve(2);
    await tick();
    expect(read(c)).toBe(2);
    expect(isPending(c)).toBe(false);
  });

  test('pending forwards: a computed reading a pending computed parks too', async () => {
    const gate = deferred<number>();
    const inner = computed((use) => use(gate.promise));
    const outer = computed(() => inner.get() + 1);
    expect(isPending(outer)).toBe(false);
    expect(() => read(outer)).toThrow();
    expect(isPending(outer)).toBe(true);
    gate.resolve(41);
    await tick();
    expect(read(outer)).toBe(42);
  });

  test('settlement behaves as a write: effects observing downstream re-run', async () => {
    const gate = deferred<number>();
    const c = computed((use) => use(gate.promise) * 2);
    const seen: unknown[] = [];
    effect(() => {
      try {
        seen.push(c.get());
      } catch {
        seen.push('pending');
      }
    });
    expect(seen).toEqual(['pending']);
    gate.resolve(21);
    await tick();
    expect(seen).toEqual(['pending', 42]);
  });
});

describe('errors are reference-stable boxes', () => {
  test('a rejected thenable rethrows the same reason at every read site', async () => {
    const gate = deferred<never>();
    const boom = new Error('boom');
    const c = computed((use) => use(gate.promise));
    try {
      read(c);
    } catch {
      /* pending */
    }
    gate.reject(boom);
    await tick();
    let e1: unknown;
    let e2: unknown;
    try {
      read(c);
    } catch (e) {
      e1 = e;
    }
    try {
      read(c);
    } catch (e) {
      e2 = e;
    }
    expect(e1).toBe(boom);
    expect(e2).toBe(boom);
  });

  test('a throwing computed forwards the same reason to downstream readers', () => {
    const boom = new Error('sync-boom');
    const c = computed(() => {
      throw boom;
    });
    const d = computed(() => c.get());
    expect(() => read(d)).toThrow(boom);
    expect(() => read(d)).toThrow(boom);
  });
});

describe('refresh classification', () => {
  /** The resource idiom: one request per (param, epoch) key, so requests are
   * stable across re-evaluations and refreshes create fresh keys. */
  function makeResource(param: ReturnType<typeof signal<number>>) {
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
      gates,
      fetchCount: () => fetchCount,
      refresh() {
        epoch++;
        refresh(data);
      },
    };
  }

  test('urgent refresh refetches with unchanged inputs; stale serves', async () => {
    const param = signal(0);
    const r = makeResource(param);
    try {
      read(r.data);
    } catch {
      /* first load parked */
    }
    r.gates.get('0:0')!.resolve('one');
    await tick();
    expect(read(r.data)).toBe('one');
    expect(r.fetchCount()).toBe(1);
    r.refresh();
    expect(read(r.data)).toBe('one'); // stale keeps serving
    expect(isPending(r.data)).toBe(true);
    expect(r.fetchCount()).toBe(2);
    r.gates.get('0:1')!.resolve('two');
    await tick();
    expect(read(r.data)).toBe('two');
  });

  test('refresh inside a draft belongs to that draft: canonical is untouched until fold', async () => {
    const param = signal(0);
    const r = makeResource(param);
    try {
      read(r.data);
    } catch {
      /* park */
    }
    r.gates.get('0:0')!.resolve('one');
    await tick();
    expect(read(r.data)).toBe('one');
    const d = ri.openDraft();
    ri.runInDraft(d.id, () => {
      param.set(1);
      r.refresh();
    });
    ri.sealDraft(d.id);
    expect(read(r.data)).toBe('one'); // canonical: no refetch yet
    const env = ri.resolveEnvelope(r.data, [d.id]);
    expect(env.kind).toBe('pending'); // the draft world is fetching '1:1'
    expect(r.fetchCount()).toBe(2);
    r.gates.get('1:1')!.resolve('TWO');
    await tick();
    expect(ri.resolveEnvelope(r.data, [d.id])).toMatchObject({ kind: 'value', value: 'TWO' });
    expect(read(r.data)).toBe('one'); // still canonical-stale
    ri.retireDraft(d.id);
    expect(read(r.data)).toBe('TWO'); // fold re-fetches nothing: same key, same gate
    expect(r.fetchCount()).toBe(2);
  });
});
