import { expect, test, vi } from 'vitest';
import {
  asyncComputed,
  atom,
  computed,
  createTrace,
  effect,
  initializeAtomState,
  read,
  refresh,
  serializeAtomState,
  set,
} from '../src';

test('direct async reads fetch once per refresh', async () => {
  let calls = 0;
  let resolve!: (value: string) => void;
  const value = asyncComputed(use => use(new Promise<string>(done => { calls++; resolve = done; })));
  let gate!: PromiseLike<unknown>;
  try { read(value); } catch (error) { gate = error as PromiseLike<unknown>; }
  expect(calls).toBe(1);
  resolve('first');
  await gate;
  expect(read(value)).toBe('first');
  expect(calls).toBe(1);
  refresh(value);
  try { read(value); } catch (error) { gate = error as PromiseLike<unknown>; }
  expect(calls).toBe(2);
  resolve('second');
  await gate;
  expect(read(value)).toBe('second');
});

test('async computations register parallel reads and keep the suspension identity', async () => {
  let resolveLeft!: (value: string) => void;
  let resolveRight!: (value: string) => void;
  const left = new Promise<string>(resolve => { resolveLeft = resolve; });
  const right = new Promise<string>(resolve => { resolveRight = resolve; });
  const value = asyncComputed(use => `${use(left) ?? ''}${use(right) ?? ''}`);
  let first: unknown;
  let second: unknown;
  try { read(value); } catch (error) { first = error; }
  try { read(value); } catch (error) { second = error; }
  expect(first).toBe(second);
  resolveLeft('L');
  resolveRight('R');
  await Promise.all([left, right]);
  expect(read(value)).toBe('LR');
});

test('lifetime observation spans computed and effect subscribers', async () => {
  const start = vi.fn();
  const stop = vi.fn();
  const source = atom(1, { effect: () => { start(); return stop; } });
  const doubled = computed(() => read(source) * 2);
  const dispose = effect(() => { read(doubled); });
  await Promise.resolve();
  expect(start).toHaveBeenCalledOnce();
  dispose();
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
});

test('SSR installation bypasses a fresh atom lazy initializer', () => {
  const server = atom(7, { key: 'count' });
  const json = serializeAtomState([server]);
  const initialize = vi.fn(() => 0);
  const client = atom(initialize, { key: 'count' });
  initializeAtomState(json, [client]);
  expect(read(client)).toBe(7);
  expect(initialize).not.toHaveBeenCalled();
});

test('trace ring counts overflow and explains the latest effect run', () => {
  const value = atom(0);
  const trace = createTrace(3);
  const dispose = effect(() => { read(value); });
  set(value, 1);
  set(value, 2);
  const events = trace.events();
  expect(events).toHaveLength(3);
  const effectTarget = events.find(event => event.kind === 'effect run')!.target!;
  expect(trace.whyLastDelivery({ id: effectTarget }).join('\n')).toContain('overflow:');
  dispose();
  trace.stop();
});
