import { describe, expect, it } from 'vitest';
import {
  atom,
  attachHost,
  computed,
  debugState,
  effect,
  read,
  resetForTest,
  type RootToken,
  type SignalHost,
  type SignalHostListener,
} from '../src/index.ts';

async function collect(reference: WeakRef<object>): Promise<boolean> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error('This test requires --expose-gc.');
  for (let attempt = 0; attempt < 80; attempt++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (reference.deref() === undefined) return true;
    // WeakRef keeps a dereferenced target alive until the current job ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

function droppedComputed(source: ReturnType<typeof atom<number>>): WeakRef<object> {
  let target: ReturnType<typeof computed<number>> | null = computed(() => source.state * 2);
  read(target);
  const reference = new WeakRef(target);
  target = null;
  return reference;
}

function droppedEffect(source: ReturnType<typeof atom<number>>, run: () => void): WeakRef<object> {
  let dispose: (() => void) | null = effect(() => {
    source.state;
    run();
  });
  const reference = new WeakRef(dispose);
  dispose = null;
  return reference;
}

class FakeHost implements SignalHost {
  listener: SignalHostListener | null = null;
  currentWriteLane(): number {
    return -128;
  }
  renderContext(): null | { container: RootToken; lanes: number } {
    return null;
  }
  runInLane<T>(lane: number, fn: () => T): T {
    return fn();
  }
  subscribe(listener: SignalHostListener): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
}

describe('leak audit', () => {
  it('collects dropped computed and effect handles', async () => {
    const source = atom(1);
    expect(await collect(droppedComputed(source))).toBe(true);

    let runs = 0;
    expect(await collect(droppedEffect(source, () => runs++))).toBe(true);
    await Promise.resolve();
    source.set(2);
    expect(runs).toBe(1);
  });

  it('reclaims all per-episode state at quiescence', () => {
    resetForTest();
    const host = new FakeHost();
    const detach = attachHost(host);
    const value = atom(0);
    value.update((current) => current + 1);
    expect(debugState().batches).toBe(1);
    host.listener?.onEventEnd();
    expect(value.state).toBe(1);
    expect(debugState()).toEqual({ batches: 0, passes: 0, touchedAtoms: 0, liveLanes: 0 });
    detach();
  });
});
