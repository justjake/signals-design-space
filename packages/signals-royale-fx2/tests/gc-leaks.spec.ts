/**
 * Leak audit (--expose-gc): dropped handles reclaim; quiescence leaves no
 * per-suspension state.
 *
 * Reclamation model under test:
 * - Unwatched computeds hold references dependency-ward only, so dropping
 *   the last user reference collects the whole chain structurally.
 * - Effect disposers are FinalizationRegistry-backed: dropping a disposer
 *   without calling it reclaims the watcher and unlinks its subscriptions.
 * - Draft retirement drops rebase logs and world memos (quiescence).
 */
import { describe, expect, test } from 'vitest';
import {
  computed,
  effect,
  effectScope,
  nodeOf,
  read,
  signal,
  type Signal,
} from '../src/index.ts';
import { observeNode, type CellNode, type Link } from '../src/graph.ts';
import {
  liveDraftCount,
  openDraft,
  resolveState,
  retireDraft,
  runInDraft,
  sealDraft,
  worldOf,
  type DraftId,
} from '../src/worlds.ts';

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
      void observeNode(nodeOf(base), () => {});
    })();
    expect(subCount(base)).toBe(1);
    await collect(10);
    expect(subCount(base)).toBe(0);
  });

  test('quiescence: retiring the last draft leaves no per-suspension state', () => {
    const a = signal(0);
    const c = computed(() => a.get() + 1);
    const d1 = openDraft();
    const d2 = openDraft();
    runInDraft(d1, () => a.set(1));
    runInDraft(d2, () => a.update((x) => x + 5));
    resolveState(nodeOf(c), worldOf([d1.id]));
    resolveState(nodeOf(c), worldOf([d1.id, d2.id]));
    expect(nodeOf(c).worldMemos).not.toBeNull();
    retireDraft(d1.id);
    expect(nodeOf(c).worldMemos).not.toBeNull(); // d2 still live
    retireDraft(d2.id);
    expect(nodeOf(c).worldMemos).toBeNull();
    expect(nodeOf(a).worldMemos).toBeNull();
    expect(liveDraftCount()).toBe(0);
    expect(read(a)).toBe(6);
  });

  test('a retired draft id in long-lived state retains neither the Draft record nor its logged intents', async () => {
    // The React bindings' contract: long-lived React state (reducer worlds,
    // committed id sets) holds draft IDS, never Draft records — a record
    // captured in a committed reducer state that never updates again would
    // be retained forever, while a stale id is inert.
    const a = signal({ n: 0 });
    const committedReducerState: DraftId[] = []; // stands in for React state that never updates again
    let draftRef!: WeakRef<object>;
    let payloadRef!: WeakRef<object>;
    (() => {
      const draft = openDraft();
      const payload = { n: 1 };
      runInDraft(draft, () => a.set(payload));
      sealDraft(draft);
      committedReducerState.push(draft.id);
      draftRef = new WeakRef(draft);
      payloadRef = new WeakRef(payload);
      retireDraft(draft.id);
    })();
    expect(read(a).n).toBe(1); // the fold landed the logged payload canonically
    a.set({ n: 2 }); // canonical moves on: nothing references the payload
    await collect(10);
    expect(committedReducerState.length).toBe(1); // the id is still held — and inert
    expect(draftRef.deref()).toBeUndefined();
    expect(payloadRef.deref()).toBeUndefined();
  });

  test('promote/demote cycling leaves no back-edges; the demoted chain collects when dropped', async () => {
    const base = signal(1);
    let finalized = false;
    const reg = new FinalizationRegistry(() => {
      finalized = true;
    });
    (() => {
      const mid = computed(() => base.get() * 2);
      const top = computed(() => mid.get() + 1);
      // Subscribe without pulling, pull through the watched tier, then
      // unsubscribe: promote installed back-edges down to the cell, and
      // demote must remove every one of them.
      const unsub = observeNode(nodeOf(top), () => {});
      expect(read(top)).toBe(3);
      expect(subCount(base)).toBe(1);
      unsub();
      expect(subCount(base)).toBe(0);
      reg.register(top, null);
    })();
    await collect();
    expect(finalized).toBe(true); // forward references only after demote
    expect(subCount(base)).toBe(0);
  });

  test('a dropped subscription over a computed chain reclaims the whole watched closure', async () => {
    const base = signal(1);
    const top = computed(() => base.get() + 1);
    (() => {
      // The subscription handle is dropped without being called.
      void observeNode(nodeOf(top), () => {});
    })();
    expect(read(top)).toBe(2); // watched evaluation links base -> top
    expect(subCount(base)).toBe(1);
    await collect(10);
    // The registry disposed the leaf; the demote cascade unhooked the chain.
    expect(subCount(base)).toBe(0);
  });

  test('disposing an effect deterministically unlinks now (no GC needed)', () => {
    const base = signal(1);
    const dispose = effect(() => void base.get());
    expect(subCount(base)).toBe(1);
    dispose();
    expect(subCount(base)).toBe(0);
  });

  test('a scope-owned effect survives GC of its unused per-effect disposer', async () => {
    const base = signal(1);
    let runs = 0;
    const disposeScope = effectScope(() => {
      // Common usage: the per-effect disposer is dropped because the scope
      // owns the effect. Collecting that disposer is not abandonment — the
      // effect must stay live until the scope goes.
      void effect(() => {
        base.get();
        runs++;
      });
    });
    expect(runs).toBe(1);
    await collect(10);
    base.set(2);
    expect(runs).toBe(2); // still alive: the scope is the owner
    disposeScope();
    base.set(3);
    expect(runs).toBe(2); // scope disposal is the reclamation path
    expect(subCount(base)).toBe(0);
  });
});
