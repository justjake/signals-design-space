/** Lifetime effects, lazy initializers, SSR, tracer. */
import { describe, expect, test } from 'vitest';
import {
  attachTracer,
  computed,
  effect,
  initializeAtomState,
  installState,
  nodeOf,
  read,
  serializeAtomState,
  signal,
  update,
} from '../src/index.ts';
import { observeNode } from '../src/graph.ts';
import { openDraft, retireDraft, runInDraft, sealDraft } from '../src/worlds.ts';

const tick = () => new Promise<void>((r) => setTimeout(r));

describe('lifetime effects', () => {
  test('first subscriber of any kind activates; last of every kind deactivates', async () => {
    const log: string[] = [];
    const a = signal(0, {
      onObserved: (ctx) => {
        log.push(`on:${ctx.get()}`);
        return () => log.push('off');
      },
    });
    const c = computed(() => a.get() * 2);
    read(c); // unobserved computed chain: no observation
    await tick();
    expect(log).toEqual([]);
    const dispose = effect(() => void c.get()); // observes the chain into a
    await tick();
    expect(log).toEqual(['on:0']);
    const unsub = observeNode(nodeOf(a), () => {}); // second kind: leaf subscription
    await tick();
    expect(log).toEqual(['on:0']); // union: still one observation
    dispose();
    await tick();
    expect(log).toEqual(['on:0']); // leaf still holds it
    unsub();
    await tick();
    expect(log).toEqual(['on:0', 'off']);
  });

  test('flaps within one tick coalesce; ctx.set writes urgently', async () => {
    const log: string[] = [];
    const a = signal(1, {
      onObserved: (ctx) => {
        log.push('on');
        ctx.set(ctx.get() + 41);
        return () => log.push('off');
      },
    });
    const d1 = effect(() => void a.get());
    d1();
    const d2 = effect(() => void a.get());
    await tick();
    expect(log).toEqual(['on']); // net one activation across the flap
    expect(read(a)).toBe(42);
    d2();
    await tick();
    expect(log).toEqual(['on', 'off']);
  });
});

describe('lazy initializers', () => {
  test('runs once at first read, not at construction', () => {
    let runs = 0;
    const a = signal(() => {
      runs++;
      return 7;
    });
    expect(runs).toBe(0);
    expect(read(a)).toBe(7);
    expect(read(a)).toBe(7);
    expect(runs).toBe(1);
  });

  test('set before first read runs the initializer first (equality base)', () => {
    let runs = 0;
    const a = signal(() => {
      runs++;
      return 1;
    });
    a.set(5);
    expect(runs).toBe(1);
    expect(read(a)).toBe(5);
  });

  test('update before first read applies against the initialized base', () => {
    const a = signal(() => 10);
    update(a, (x) => x + 5);
    expect(read(a)).toBe(15);
  });

  test('an initializer is forbidden from writing', () => {
    const b = signal(0);
    const a = signal((): number => {
      b.set(1);
      return 0;
    });
    expect(() => read(a)).toThrow(/initializer/);
  });

  test('subscription materializes', () => {
    let runs = 0;
    const a = signal(() => {
      runs++;
      return 3;
    });
    const unsub = observeNode(nodeOf(a), () => {});
    expect(runs).toBe(1);
    unsub();
  });
});

describe('SSR', () => {
  test('serialize/initialize round-trips; install skips initializers and is not a write', () => {
    const s1 = signal(1);
    const s2 = signal('x');
    s1.set(5);
    const json = serializeAtomState([s1, s2]);
    let initRuns = 0;
    const c1 = signal((): number => {
      initRuns++;
      return 0;
    });
    const c2 = signal('default');
    let effectRuns = 0;
    const dispose = effect(() => {
      void c2.get();
      effectRuns++;
    });
    initializeAtomState(json, [c1, c2]);
    expect(initRuns).toBe(0);
    expect(effectRuns).toBe(1); // install did not count as a write
    expect(read(c1)).toBe(5);
    expect(read(c2)).toBe('x');
    expect(initRuns).toBe(0);
    dispose();
  });

  test('record keys and replacer/reviver pass through', () => {
    const a = signal(2);
    const json = serializeAtomState({ count: a }, (_k, v) => (typeof v === 'number' ? v * 10 : v));
    const b = signal(0);
    initializeAtomState(json, { count: b }, (_k, v) => (typeof v === 'number' ? v / 10 : v));
    expect(read(b)).toBe(2);
    const fresh = signal(0);
    installState(fresh, 9);
    expect(read(fresh)).toBe(9);
  });
});

describe('causality tracer', () => {
  test('chains: effect run -> write -> parent write; ring bounds with counted overflow', () => {
    const t = attachTracer({ capacity: 16 });
    const a = signal(0, { label: 'a' });
    const b = signal(0, { label: 'b' });
    effect(() => b.set(a.get() + 1)); // writes b whenever a changes
    a.set(1);
    const events = t.events();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('write');
    expect(kinds).toContain('effect-run');
    // The write to b is caused by the effect run, which is caused by the
    // write to a.
    const writeB = [...events].reverse().find((e) => e.kind === 'write' && e.label === 'b')!;
    const effectRun = events.find((e) => e.id === writeB.cause)!;
    expect(effectRun.kind).toBe('effect-run');
    const writeA = events.find((e) => e.id === effectRun.cause)!;
    expect(writeA.kind).toBe('write');
    expect(writeA.label).toBe('a');
    // Unrelated operations never chain.
    const unrelated = signal(0, { label: 'u' });
    unrelated.set(1);
    const writeU = t.events().find((e) => e.kind === 'write' && e.label === 'u')!;
    expect(writeU.cause).toBe(0);
    // Overflow is counted, never silent.
    for (let i = 0; i < 100; i++) a.set(i + 10);
    expect(t.dropped).toBeGreaterThan(0);
    expect(t.events().length).toBeLessThanOrEqual(16);
    t.stop();
  });

  test('draft chains: retire event points at the draft last write, opens the fold writes', () => {
    const t = attachTracer();
    const a = signal(1, { label: 'a' });
    const d = openDraft();
    runInDraft(d, () => a.update((x) => x + 1));
    sealDraft(d);
    retireDraft(d.id);
    const events = t.events();
    const retire = events.find((e) => e.kind === 'draft-retire')!;
    const draftWrite = events.find((e) => e.id === retire.cause)!;
    expect(draftWrite.kind).toBe('write');
    const foldWrite = [...events].reverse().find((e) => e.kind === 'write' && e.label === 'a')!;
    expect(foldWrite.cause).toBe(retire.id);
    t.stop();
  });
});
