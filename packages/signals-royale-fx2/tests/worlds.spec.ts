/** Engine-level world semantics: drafts, replay order, fold, views. */
import { describe, expect, test } from 'vitest';
import {
  computed,
  effect,
  isPending,
  latest,
  committed,
  reactIntegration as ri,
  read,
  signal,
} from '../src/index.ts';

function inDraft(fn: () => void): number {
  const d = ri.openDraft();
  ri.runInDraft(d.id, fn);
  ri.sealDraft(d.id);
  return d.id;
}

describe('draft visibility', () => {
  test('draft writes are invisible to canonical readers until retirement', () => {
    const a = signal(0);
    const id = inDraft(() => a.set(1));
    expect(read(a)).toBe(0);
    expect(latest(a)).toBe(1);
    expect(ri.resolveEnvelope(a, [id])).toEqual({ kind: 'value', value: 1 });
    ri.retireDraft(id);
    expect(read(a)).toBe(1);
    expect(latest(a)).toBe(1);
  });

  test('retirement folds through the write path: effects run once per fold', () => {
    const a = signal(0);
    const b = signal(0);
    let runs = 0;
    effect(() => {
      a.get();
      b.get();
      runs++;
    });
    const id = inDraft(() => {
      a.set(1);
      b.set(2);
    });
    expect(runs).toBe(1); // drafts do not touch effects
    ri.retireDraft(id);
    expect(runs).toBe(2); // one batched fold
  });

  test('discard rolls back: canonical unchanged, latest reverts', () => {
    const a = signal(5);
    const id = inDraft(() => a.update((x) => x + 10));
    expect(latest(a)).toBe(15);
    ri.discardDraft(id);
    expect(latest(a)).toBe(5);
    expect(read(a)).toBe(5);
  });

  test('a silent fold keeps the react epoch still but advances the canonical epoch', () => {
    const a = signal(1);
    // A bail-style subscriber outside any scope: re-reads only when its
    // snapshot changes (the useSyncExternalStore contract). Its snapshot is
    // the canonical epoch — render-pass worlds never deliver to it, so the
    // fold must be visible on its channel.
    let snap = ri.canonicalEpochSnapshot(a);
    let view = read(a);
    const unsub = ri.subscribe(a, () => {
      const s = ri.canonicalEpochSnapshot(a);
      if (s === snap) return;
      snap = s;
      view = read(a);
    });
    const reactSnapBefore = ri.epochSnapshot(a);
    const id = inDraft(() => a.set(9));
    expect(view).toBe(1); // drafts stay invisible to canonical subscribers
    ri.retireDraft(id, { silent: true });
    expect(read(a)).toBe(9);
    expect(view).toBe(9); // the fold reached the canonical channel
    // The world-delivered channel stayed silent: scoped subscribers, whose
    // render passes already carried the draft, schedule no repair renders.
    expect(ri.epochSnapshot(a)).toBe(reactSnapBefore);
    unsub();
  });
});

describe('dispatch-order replay (React updater-queue arithmetic)', () => {
  test('transition +1 then urgent *2: urgent shows 2, world shows (1+1)*2', () => {
    const a = signal(1);
    const id = inDraft(() => a.update((x) => x + 1));
    a.update((x) => x * 2);
    expect(read(a)).toBe(2); // urgent skipped the draft, applied *2 to base 1
    expect(ri.resolveEnvelope(a, [id])).toEqual({ kind: 'value', value: 4 }); // (1+1)*2
    ri.retireDraft(id);
    expect(read(a)).toBe(4);
  });

  test('transition +2 then urgent *2: urgent shows 2, lands at 6 — replay, not reorder', () => {
    const a = signal(1);
    const id = inDraft(() => a.update((x) => x + 2));
    a.update((x) => x * 2);
    expect(read(a)).toBe(2);
    expect(ri.resolveEnvelope(a, [id])).toEqual({ kind: 'value', value: 6 }); // (1+2)*2
    ri.retireDraft(id);
    expect(read(a)).toBe(6);
  });

  test('two drafts interleaved with urgent writes replay in dispatch order', () => {
    const a = signal(1);
    const d1 = inDraft(() => a.update((x) => x + 1)); // seq1
    a.update((x) => x * 10); // seq2 urgent
    const d2 = inDraft(() => a.update((x) => x + 3)); // seq3
    expect(read(a)).toBe(10);
    expect(ri.resolveEnvelope(a, [d1])).toEqual({ kind: 'value', value: 20 }); // (1+1)*10
    expect(ri.resolveEnvelope(a, [d2])).toEqual({ kind: 'value', value: 13 }); // 1*10+3
    expect(ri.resolveEnvelope(a, [d1, d2])).toEqual({ kind: 'value', value: 23 }); // (1+1)*10+3
    ri.retireDraft(d1);
    expect(read(a)).toBe(20);
    // d2's world resolves the same values before and after d1's fold.
    expect(ri.resolveEnvelope(a, [d1, d2])).toEqual({ kind: 'value', value: 23 });
    expect(ri.resolveEnvelope(a, [d2])).toEqual({ kind: 'value', value: 23 });
    ri.retireDraft(d2);
    expect(read(a)).toBe(23);
  });
});

describe('computeds across worlds', () => {
  test('a computed resolves per world, with per-world dependency branches', () => {
    const flag = signal(false);
    const left = signal('L');
    const right = signal('R');
    const pick = computed(() => (flag.get() ? right.get() : left.get()));
    expect(read(pick)).toBe('L');
    const id = inDraft(() => flag.set(true));
    expect(read(pick)).toBe('L'); // canonical branch untouched
    expect(ri.resolveEnvelope(pick, [id])).toEqual({ kind: 'value', value: 'R' });
    ri.retireDraft(id);
    expect(read(pick)).toBe('R');
  });

  test('world memos keep identity while inputs are stable', () => {
    const a = signal({ n: 1 });
    const c = computed(() => ({ n: a.get().n + 1 }));
    const id = inDraft(() => a.set({ n: 5 }));
    const env1 = ri.resolveEnvelope(c, [id]);
    const env2 = ri.resolveEnvelope(c, [id]);
    expect(env1).toBe(env2); // stable identity for unchanged resolution
    expect((env1 as { value: { n: number } }).value.n).toBe(6);
    ri.retireDraft(id);
  });

  test('isPending flips for drafted cells and computeds over them', () => {
    const a = signal(1);
    const c = computed(() => a.get() * 2);
    expect(read(c)).toBe(2); // establish canonical deps
    expect(isPending(a)).toBe(false);
    expect(isPending(c)).toBe(false);
    const id = inDraft(() => a.set(9));
    expect(isPending(a)).toBe(true);
    expect(isPending(c)).toBe(true);
    ri.retireDraft(id);
    expect(isPending(a)).toBe(false);
    expect(isPending(c)).toBe(false);
    expect(read(c)).toBe(18);
  });

  test('a draft append notifies leaf observers of computeds over the cell', () => {
    // Pending probes subscribe to the node they probe, not to its inputs.
    // Draft activity on an input must therefore travel the watched edges
    // down to leaf observers, or a probe over a computed never wakes up —
    // its snapshot would flip (the deps scan sees the drafted cell) but
    // nothing tells it to look.
    const a = signal(1);
    const c = computed(() => a.get() * 2);
    const flips: boolean[] = [];
    const unsub = ri.subscribe(c, () => flips.push(isPending(c)));
    expect(read(c)).toBe(2); // establish the watched a -> c edge
    const id = inDraft(() => a.set(9));
    expect(flips).toContain(true); // the append reached the probe
    ri.retireDraft(id, { silent: true });
    expect(flips[flips.length - 1]).toBe(false); // and so did the fold
    expect(read(c)).toBe(18);
    unsub();
  });
});

describe('per-root committed views', () => {
  test('committed(x, container) tracks each root, then converges after fold', () => {
    const a = signal(0);
    const rootA = {};
    const rootB = {};
    const id = inDraft(() => a.set(1));
    ri.setCommittedWorld(rootA, [id]); // root A committed the transition
    ri.setCommittedWorld(rootB, []); // root B still on base
    expect(committed(a, rootA)).toBe(1);
    expect(committed(a, rootB)).toBe(0);
    expect(committed(a)).toBe(0); // no container: canonical
    ri.retireDraft(id);
    expect(committed(a, rootA)).toBe(1);
    expect(committed(a, rootB)).toBe(1); // retired drafts resolve as no-ops
  });
});

describe('latest() context resolution', () => {
  // The rule: latest() means "newest intent" only in AMBIENT code. Inside an
  // evaluation context it resolves that context's own world — reading ahead
  // of your world is a tear.

  test('inside a canonical computed evaluation, latest() resolves canonical — never a draft', () => {
    const a = signal(1);
    const c = computed(() => latest(a) * 10);
    const id = inDraft(() => a.set(2));
    expect(read(c)).toBe(10); // canonical evaluation must not read ahead
    expect(ri.resolveEnvelope(c, [id])).toEqual({ kind: 'value', value: 20 }); // its own world
    expect(latest(c)).toBe(20); // ambient: newest intent
    ri.retireDraft(id);
    expect(read(c)).toBe(20);
  });

  test('latest() inside a computed is a tracked dependency — no permanent staleness', () => {
    const a = signal(1);
    const c = computed(() => latest(a) + 1);
    expect(read(c)).toBe(2);
    a.set(5);
    expect(read(c)).toBe(6);
  });

  test('latest() inside an effect tracks canonically: re-runs on folds, never on draft writes', () => {
    const a = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(latest(a));
    });
    a.set(1);
    expect(seen).toEqual([0, 1]);
    const id = inDraft(() => a.set(9));
    expect(seen).toEqual([0, 1]); // draft writes are invisible to effects
    ri.retireDraft(id);
    expect(seen).toEqual([0, 1, 9]); // the fold is a write: effect re-runs
  });

  test('render-world resolution is scoped by the provider: outside render, latest() is ambient', () => {
    const a = signal(0);
    let rendering = true;
    ri.setRenderWorldProvider(() => (rendering ? [] : null));
    try {
      const id = inDraft(() => a.set(7));
      expect(latest(a)).toBe(0); // an urgent pass's render body: the pass's world, not the draft
      rendering = false;
      expect(latest(a)).toBe(7); // ambient again: newest intent
      ri.retireDraft(id);
    } finally {
      ri.setRenderWorldProvider(null);
    }
  });
});

describe('quiescence', () => {
  test('retiring the last draft drops logs and world memos', async () => {
    const a = signal(0);
    const c = computed(() => a.get() + 1);
    const id = inDraft(() => a.set(1));
    ri.resolveEnvelope(c, [id]);
    expect(ri.liveDraftCount()).toBe(1);
    ri.retireDraft(id);
    expect(ri.liveDraftCount()).toBe(0);
    expect(ri.nodeOf(c).worldMemos).toBeNull();
    expect(ri.nodeOf(a).worldMemos).toBeNull();
  });
});
