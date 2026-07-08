import { expect, test } from 'vitest';
import { atom, debugStats, reset } from '../src';

test('dropped atom handles release their slab slots', async () => {
  reset();
  const reference = (() => {
    const cell = atom({ payload: new Array(100).fill(1) });
    return new WeakRef(cell);
  })();
  for (let i = 0; i < 40; i++) {
    (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(reference.deref()).toBeUndefined();
  expect(debugStats()).toEqual({ cells: 0, pendingEffects: 0 });
});
