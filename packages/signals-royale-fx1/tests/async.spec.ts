/**
 * Engine-level async semantics: parallel registration, stable identity,
 * settlement-as-write, error boxes, stale serving, refresh races.
 */
import { afterEach, expect, test } from 'vitest';
import {
  atom,
  computed,
  effect,
  read,
  latest,
  isPending,
  refresh,
  resetEngine,
  peekSlot,
  Pending,
  Failure,
  setHost,
} from '../src/index';

afterEach(() => {
  setHost(null);
  resetEngine();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((res) => setTimeout(res, 0));

test('all async reads register before the evaluation parks: parallel fetches', () => {
  const d1 = deferred<number>();
  const d2 = deferred<number>();
  let fetches = 0;
  const c = computed((use) => {
    fetches++;
    const a = use(d1.promise);
    const b = use(d2.promise); // still runs: use() returns a placeholder
    return (a as number) + (b as number);
  });
  const slot = peekSlot(c, null);
  expect(slot).toBeInstanceOf(Pending);
  expect(fetches).toBe(1); // one run registered both thenables
});

test('pending identity is stable across re-reads; settlement completes the value', async () => {
  const d1 = deferred<number>();
  const c = computed((use) => use(d1.promise) * 2);
  const first = peekSlot(c, null);
  const second = peekSlot(c, null);
  expect(first).toBe(second); // a retry re-reads the same parked evaluation
  d1.resolve(21);
  await tick();
  expect(read(c)).toBe(42);
});

test('downstream evaluations forward pending; both settle together', async () => {
  const d1 = deferred<number>();
  const inner = computed((use) => use(d1.promise));
  const outer = computed(() => (inner.get() as number) + 1);
  expect(peekSlot(outer, null)).toBeInstanceOf(Pending);
  d1.resolve(1);
  await tick();
  await tick();
  expect(read(outer)).toBe(2);
});

test('settlement behaves as a write: live effects re-run with the new value', async () => {
  const d1 = deferred<string>();
  const c = computed((use) => use(d1.promise));
  const seen: unknown[] = [];
  effect(() => {
    try {
      seen.push(read(c)); // tracked; throws the representative while pending
    } catch {
      seen.push('pending');
    }
  });
  expect(seen).toEqual(['pending']);
  d1.resolve('data');
  await tick();
  expect(seen).toEqual(['pending', 'data']);
});

test('errors become reference-stable boxes rethrown at read sites', async () => {
  const d1 = deferred<number>();
  const c = computed((use) => use(d1.promise));
  const boom = new Error('boom');
  void peekSlot(c, null);
  d1.reject(boom);
  await tick();
  let err1: unknown;
  let err2: unknown;
  try {
    read(c);
  } catch (e) {
    err1 = e;
  }
  try {
    read(c);
  } catch (e) {
    err2 = e;
  }
  expect(err1).toBe(boom);
  expect(err2).toBe(boom);
  const downstream = computed(() => c.get());
  try {
    read(downstream);
  } catch (e) {
    expect(e).toBe(boom); // the chain rethrows the same reference
  }
});

test('refresh serves stale, flags pending, and the latest refetch wins races', async () => {
  // One request per epoch; the epoch lives outside the graph and bumps with
  // each refresh, so a refresh with unchanged inputs still fetches fresh.
  let epoch = 0;
  const gates = new Map<number, ReturnType<typeof deferred<string>>>();
  const c = computed((use) => {
    let g = gates.get(epoch);
    if (g === undefined) {
      g = deferred<string>();
      gates.set(epoch, g);
    }
    return use(g.promise);
  });
  void peekSlot(c, null);
  gates.get(0)!.resolve('v1');
  await tick();
  expect(read(c)).toBe('v1');
  expect(isPending(c)).toBe(false);
  epoch = 1;
  refresh(c); // starts request 1 eagerly
  // Consumers keep reading the settled value while the refetch runs.
  expect(read(c)).toBe('v1');
  expect(latest(c)).toBe('v1');
  expect(isPending(c)).toBe(true);
  epoch = 2;
  refresh(c); // race: a second refetch before the first settles
  gates.get(1)!.resolve('stale-answer');
  gates.get(2)!.resolve('fresh-answer');
  await tick();
  await tick();
  expect(read(c)).toBe('fresh-answer'); // latest-wins
  expect(isPending(c)).toBe(false);
});

test('input changes reset fetch generations; settle re-runs keep them', async () => {
  const param = atom(1);
  const requests: number[] = [];
  const c = computed((use) => {
    const p = param.get();
    requests.push(p);
    const g = deferred<number>();
    queueMicrotask(() => g.resolve(p * 10));
    return use(g.promise);
  });
  void peekSlot(c, null);
  await tick();
  expect(read(c)).toBe(10);
  const before = requests.length;
  param.set(2); // real input change: a fresh fetch is legitimate
  void peekSlot(c, null); // cold node: the read starts the new evaluation
  await tick();
  await tick();
  expect(read(c)).toBe(20);
  expect(requests.length).toBeGreaterThan(before);
});

test('canonical read of never-settled pending throws the representative promise', () => {
  const d1 = deferred<number>();
  const c = computed((use) => use(d1.promise));
  let thrown: unknown;
  try {
    read(c);
  } catch (e) {
    thrown = e;
  }
  expect(typeof (thrown as PromiseLike<unknown>)?.then).toBe('function');
  const box = peekSlot(c, null);
  expect(box).toBeInstanceOf(Pending);
  expect((box as Pending).promise).toBe(thrown);
});

test('a rejected read wins only when nothing is still pending', async () => {
  const bad = deferred<number>();
  const slow = deferred<number>();
  const c = computed((use) => use(bad.promise) + use(slow.promise));
  void peekSlot(c, null);
  bad.reject(new Error('bad'));
  await tick();
  // slow is still pending: a retry may resolve differently, stay pending.
  expect(peekSlot(c, null)).toBeInstanceOf(Pending);
  slow.resolve(1);
  await tick();
  expect(peekSlot(c, null)).toBeInstanceOf(Failure);
});
