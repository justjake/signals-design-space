/** Engine-level world semantics: drafts, replay order, fold, views. */
import { describe, expect, test } from 'vitest';
import {
  computed,
  effect,
  isPending,
  latest,
  committed,
  nodeOf,
  read,
  setRenderWorldProvider,
  signal,
  type Computed,
  type Signal,
} from '../src/index.ts';
import {
  discardDraft,
  liveDraftCount,
  openDraft,
  resolveState,
  retireDraft,
  runInDraft,
  sealDraft,
  setCommittedWorld,
  worldOf,
  type DraftId,
} from '../src/worlds.ts';
import { observeNode } from '../src/graph.ts';

function inDraft(fn: () => void): DraftId {
  const d = openDraft();
  runInDraft(d, fn);
  sealDraft(d);
  return d.id;
}

/** Resolve a handle's state as seen by the world of these draft ids. */
function stateIn(x: Signal<any> | Computed<any>, ids: readonly DraftId[]): unknown {
  return resolveState(nodeOf(x), worldOf(ids));
}

/** A drafted world's memo record for a plain value (the DerivedState shape:
 * async flag bits clear, no throwable). */
function valueState(value: unknown): { flags: number; value: unknown; throwable: null } {
  return { flags: 0, value, throwable: null };
}

describe('draft visibility', () => {
  test('draft writes are invisible to base-state readers until retirement', () => {
    const a = signal(0);
    const id = inDraft(() => a.set(1));
    expect(read(a)).toBe(0);
    expect(latest(a)).toBe(1);
    expect(stateIn(a, [id])).toEqual(valueState(1));
    retireDraft(id);
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
    retireDraft(id);
    expect(runs).toBe(2); // one batched fold
  });

  test('discard rolls back: base state unchanged, latest reverts', () => {
    const a = signal(5);
    const id = inDraft(() => a.update((x) => x + 10));
    expect(latest(a)).toBe(15);
    discardDraft(id);
    expect(latest(a)).toBe(5);
    expect(read(a)).toBe(5);
  });

  test('fold loudness is per subscriber: rendered-world resolutions decide who re-renders', () => {
    // There is no global silent/loud fold state: at retire, the fold's
    // writes notify subscribers, and each re-renders only if resolving its
    // OWN rendered world now differs from what it rendered (the bindings'
    // notify predicate). This pins the engine half of that contract: a
    // carrier's world resolves the SAME value before and after the fold
    // (retired ids normalize out), while the base world's resolution moves.
    const a = signal(1);
    const id = inDraft(() => a.set(9));
    // Before the fold: the carrier rendered 9 from its world; base shows 1.
    expect(resolveState(nodeOf(a), worldOf([id])).value).toBe(9);
    expect(resolveState(nodeOf(a), worldOf([])).value).toBe(1);
    retireDraft(id);
    expect(read(a)).toBe(9); // the fold landed in base state
    // Carrier's world still resolves 9 — equal to what it rendered: silent.
    expect(resolveState(nodeOf(a), worldOf([id])).value).toBe(9);
    // The base world resolves 9 ≠ the 1 an unaware subscriber rendered:
    // that subscriber is owed a repair render.
    expect(resolveState(nodeOf(a), worldOf([])).value).toBe(9);
  });
});

describe('dispatch-order replay (React updater-queue arithmetic)', () => {
  test('transition +1 then urgent *2: urgent shows 2, world shows (1+1)*2', () => {
    const a = signal(1);
    const id = inDraft(() => a.update((x) => x + 1));
    a.update((x) => x * 2);
    expect(read(a)).toBe(2); // urgent skipped the draft, applied *2 to base 1
    expect(stateIn(a, [id])).toEqual(valueState(4)); // (1+1)*2
    retireDraft(id);
    expect(read(a)).toBe(4);
  });

  test('transition +2 then urgent *2: urgent shows 2, lands at 6 — replay, not reorder', () => {
    const a = signal(1);
    const id = inDraft(() => a.update((x) => x + 2));
    a.update((x) => x * 2);
    expect(read(a)).toBe(2);
    expect(stateIn(a, [id])).toEqual(valueState(6)); // (1+2)*2
    retireDraft(id);
    expect(read(a)).toBe(6);
  });

  test('[falsify-first, oracle catch seed 5] an urgent equality-cutoff write on a drafted cell re-wakes the draft audience', () => {
    // An urgent intent on a drafted cell rebases the pending worlds even
    // when the base-state write cuts off on equality: replaying …+1 gives
    // 6, but …+1…set(5) gives 5. No wave runs (base state never moved), so without
    // an explicit poke-and-wake the draft's audience keeps the pre-rebase
    // value and the transition would commit it.
    const a = signal(5);
    const d = openDraft();
    const wakes: number[] = [];
    const unsub = observeNode(nodeOf(a), () => {}, (id) => wakes.push(id));
    runInDraft(d, () => a.update((x) => x + 1));
    expect(wakes).toEqual([d.id]);
    expect(stateIn(a, [d.id])).toEqual(valueState(6));
    a.set(5); // equality cutoff: base state stays 5, no propagation
    expect(stateIn(a, [d.id])).toEqual(valueState(5)); // ...but the replay rebased
    expect(wakes).toEqual([d.id, d.id]); // and the audience heard about it
    retireDraft(d.id);
    expect(read(a)).toBe(5);
    unsub();
  });

  test('two drafts interleaved with urgent writes replay in dispatch order', () => {
    const a = signal(1);
    const d1 = inDraft(() => a.update((x) => x + 1)); // seq1
    a.update((x) => x * 10); // seq2 urgent
    const d2 = inDraft(() => a.update((x) => x + 3)); // seq3
    expect(read(a)).toBe(10);
    expect(stateIn(a, [d1])).toEqual(valueState(20)); // (1+1)*10
    expect(stateIn(a, [d2])).toEqual(valueState(13)); // 1*10+3
    expect(stateIn(a, [d1, d2])).toEqual(valueState(23)); // (1+1)*10+3
    retireDraft(d1);
    expect(read(a)).toBe(20);
    // d2's world resolves the same values before and after d1's fold.
    expect(stateIn(a, [d1, d2])).toEqual(valueState(23));
    expect(stateIn(a, [d2])).toEqual(valueState(23));
    retireDraft(d2);
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
    expect(read(pick)).toBe('L'); // base-state branch untouched
    expect(stateIn(pick, [id])).toEqual(valueState('R'));
    retireDraft(id);
    expect(read(pick)).toBe('R');
  });

  test('world memos keep identity while inputs are stable', () => {
    const a = signal({ n: 1 });
    const c = computed(() => ({ n: a.get().n + 1 }));
    const id = inDraft(() => a.set({ n: 5 }));
    const state1 = stateIn(c, [id]);
    const state2 = stateIn(c, [id]);
    expect(state1).toBe(state2); // stable identity for unchanged resolution
    expect((state1 as { value: { n: number } }).value.n).toBe(6);
    retireDraft(id);
  });

  test('isPending flips for drafted cells and computeds over them', () => {
    const a = signal(1);
    const c = computed(() => a.get() * 2);
    expect(read(c)).toBe(2); // establish base-state deps
    expect(isPending(a)).toBe(false);
    expect(isPending(c)).toBe(false);
    const id = inDraft(() => a.set(9));
    expect(isPending(a)).toBe(true);
    expect(isPending(c)).toBe(true);
    retireDraft(id);
    expect(isPending(a)).toBe(false);
    expect(isPending(c)).toBe(false);
    expect(read(c)).toBe(18);
  });

  test('isPending is transitive through computeds (Solid 2.0 status forwarding)', () => {
    // Solid 2.0's pending rule: a computed over a pending source is itself
    // pending — status forwards through derivation. A drafted cell two
    // levels down must surface at the top of the chain.
    const a = signal(1);
    const c1 = computed(() => a.get() * 10);
    const c2 = computed(() => c1.get() + 1);
    expect(read(c2)).toBe(11); // establish base-state deps a → c1 → c2
    expect(isPending(c2)).toBe(false);
    const id = inDraft(() => a.set(2));
    expect(isPending(c1)).toBe(true); // direct input
    expect(isPending(c2)).toBe(true); // transitive — through the computed
    retireDraft(id);
    expect(isPending(c2)).toBe(false);
  });

  test('a draft append notifies subscribers of computeds over the cell', () => {
    // Pending probes subscribe to the node they probe, not to its inputs.
    // Draft activity on an input must therefore travel the watched edges
    // down to the subscribers, or a probe over a computed never wakes up —
    // its snapshot would flip (the deps scan sees the drafted cell) but
    // nothing tells it to look.
    const a = signal(1);
    const c = computed(() => a.get() * 2);
    const flips: boolean[] = [];
    const unsub = observeNode(nodeOf(c), () => flips.push(isPending(c)));
    expect(read(c)).toBe(2); // establish the watched a -> c edge
    const id = inDraft(() => a.set(9));
    expect(flips).toContain(true); // the append reached the probe
    retireDraft(id);
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
    setCommittedWorld(rootA, [id]); // root A committed the transition
    setCommittedWorld(rootB, []); // root B still on base
    expect(committed(a, rootA)).toBe(1);
    expect(committed(a, rootB)).toBe(0);
    expect(committed(a)).toBe(0); // no container: base state
    retireDraft(id);
    expect(committed(a, rootA)).toBe(1);
    expect(committed(a, rootB)).toBe(1); // retired drafts resolve as no-ops
  });
});

describe('latest() context resolution', () => {
  // The rule: latest() means "newest intent" only in AMBIENT code. Inside an
  // evaluation context it resolves that context's own world — reading ahead
  // of your world is a tear.

  test('inside a base-state computed evaluation, latest() resolves base state — never a draft', () => {
    const a = signal(1);
    const c = computed(() => latest(a) * 10);
    const id = inDraft(() => a.set(2));
    expect(read(c)).toBe(10); // base-state evaluation must not read ahead
    expect(stateIn(c, [id])).toEqual(valueState(20)); // its own world
    expect(latest(c)).toBe(20); // ambient: newest intent
    retireDraft(id);
    expect(read(c)).toBe(20);
  });

  test('latest() inside a computed is a tracked dependency — no permanent staleness', () => {
    const a = signal(1);
    const c = computed(() => latest(a) + 1);
    expect(read(c)).toBe(2);
    a.set(5);
    expect(read(c)).toBe(6);
  });

  test('latest() inside an effect tracks base state: re-runs on folds, never on draft writes', () => {
    const a = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(latest(a));
    });
    a.set(1);
    expect(seen).toEqual([0, 1]);
    const id = inDraft(() => a.set(9));
    expect(seen).toEqual([0, 1]); // draft writes are invisible to effects
    retireDraft(id);
    expect(seen).toEqual([0, 1, 9]); // the fold is a write: effect re-runs
  });

  test('render-world resolution is scoped by the provider: outside render, latest() is ambient', () => {
    const a = signal(0);
    let rendering = true;
    setRenderWorldProvider(() => (rendering ? [] : null));
    try {
      const id = inDraft(() => a.set(7));
      expect(latest(a)).toBe(0); // an urgent pass's render body: the pass's world, not the draft
      rendering = false;
      expect(latest(a)).toBe(7); // ambient again: newest intent
      retireDraft(id);
    } finally {
      setRenderWorldProvider(null);
    }
  });
});

describe('quiescence', () => {
  test('retiring the last draft drops logs and world memos', async () => {
    const a = signal(0);
    const c = computed(() => a.get() + 1);
    const id = inDraft(() => a.set(1));
    stateIn(c, [id]);
    expect(liveDraftCount()).toBe(1);
    retireDraft(id);
    expect(liveDraftCount()).toBe(0);
    expect(nodeOf(c).worldMemos).toBeNull();
    expect(nodeOf(a).worldMemos).toBeNull();
  });
});
