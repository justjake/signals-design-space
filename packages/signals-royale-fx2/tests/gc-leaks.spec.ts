/**
 * Leak audit (--expose-gc): dropped handles reclaim; quiescence leaves no
 * per-episode state.
 *
 * Reclamation model under test:
 * - Unwatched computeds hold references dependency-ward only, so dropping
 *   the last user reference collects the whole chain structurally.
 * - Effect disposers are FinalizationRegistry-backed: dropping a disposer
 *   without calling it reclaims the watcher and unlinks its subscriptions.
 * - Draft retirement drops rebase logs and world memos (quiescence).
 */
import { describe, expect, test } from 'vitest';
import { computed, effect, reactIntegration as ri, read, signal, type Signal } from '../src/index.ts';
import { type CellNode, type Link } from '../src/graph.ts';

function subCount(x: Signal<number>): number {
  let n = 0;
  for (let l: Link | undefined = (x.node as CellNode<number>).subs; l !== undefined; l = l.nextSub) n++;
  return n;
}

async function collect(times = 5): Promise<void> {
  if (typeof gc !== 'function') throw new Error('run with --expose-gc');
  for (let i = 0; i < times; i++) {
    gc!();
    await new Promise<void>((r) => setTimeout(() => r(), 10));
  }
}

describe('leak audit', () => {
  test('a dropped unwatched computed chain is collected (no registry needed)', async () => {
    const base = signal(1);
    let finalized = false;
    const reg = new FinalizationRegistry(() => {
      finalized = true;
    });
    (() => {
      const mid = computed(() => base.get() * 2);
      const top = computed(() => mid.get() + 1);
      expect(read(top)).toBe(3);
      reg.register(top, null);
    })();
    await collect();
    expect(finalized).toBe(true);
    expect(subCount(base)).toBe(0); // unwatched reads never registered subscriptions
  });

  test('a dropped effect disposer reclaims the watcher and its subscriptions', async () => {
    const base = signal(1);
    let runs = 0;
    (() => {
      // The disposer is dropped without being called.
      void effect(() => {
        base.get();
        runs++;
      });
    })();
    expect(subCount(base)).toBe(1);
    expect(runs).toBe(1);
    await collect(10);
    expect(subCount(base)).toBe(0); // registry unhooked the dropped effect
    base.set(2);
    expect(runs).toBe(1); // and it never runs again
  });

  test('a dropped leaf subscription handle reclaims', async () => {
    const base = signal(1);
    (() => {
      void ri.subscribe(base, () => {});
    })();
    expect(subCount(base)).toBe(1);
    await collect(10);
    expect(subCount(base)).toBe(0);
  });

  test('quiescence: retiring the last draft leaves no per-episode state', () => {
    const a = signal(0);
    const c = computed(() => a.get() + 1);
    const d1 = ri.openDraft();
    const d2 = ri.openDraft();
    ri.runInDraft(d1.id, () => a.set(1));
    ri.runInDraft(d2.id, () => a.update((x) => x + 5));
    ri.resolveEnvelope(c, [d1.id]);
    ri.resolveEnvelope(c, [d1.id, d2.id]);
    expect(ri.nodeOf(c).worldMemos).not.toBeNull();
    ri.retireDraft(d1.id);
    expect(ri.nodeOf(c).worldMemos).not.toBeNull(); // d2 still live
    ri.retireDraft(d2.id);
    expect(ri.nodeOf(c).worldMemos).toBeNull();
    expect(ri.nodeOf(a).worldMemos).toBeNull();
    expect(ri.liveDraftCount()).toBe(0);
    expect(read(a)).toBe(6);
  });

  test('disposing an effect deterministically unlinks now (no GC needed)', () => {
    const base = signal(1);
    const dispose = effect(() => void base.get());
    expect(subCount(base)).toBe(1);
    dispose();
    expect(subCount(base)).toBe(0);
  });
});
