/**
 * Leak audit (--expose-gc): dropped handles reclaim; a quiescent engine holds
 * no per-episode state.
 */
import { expect, test } from "vitest";
import {
  atom,
  computed,
  effect,
  read,
  setHost,
  resetEngine,
  episodeFor,
  beginPass,
  commitPass,
  debugFootprint,
  subscribe,
  SUB_NEVER,
  type Sub,
} from "../src/index";

declare const gc: () => void;

/**
 * Collect from an empty stack: V8 scans the machine stack conservatively, so
 * a gc() issued from a deep test frame can retain dead temporaries. A timer
 * callback runs with a clean stack; suspended async frames live on the heap
 * and are scanned precisely.
 */
function gcFromEmptyStack(): Promise<void> {
  return new Promise((res) =>
    setTimeout(() => {
      gc();
      setTimeout(res, 0);
    }, 0),
  );
}

async function gcUntil(pred: () => boolean, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await gcFromEmptyStack();
    if (pred()) return;
  }
}

/** Create-and-drop in its own frame so no stack slot of the test function
 * conservatively retains the temporary. */
function makeDroppedComputed(a: ReturnType<typeof atom<number>>): WeakRef<object> {
  const c = computed(() => a.get() * 2);
  expect(read(c)).toBe(2); // evaluated: forward edges exist
  return new WeakRef(c);
}

test("a dropped computed is collectable: cold nodes are never referenced by their sources", async () => {
  resetEngine();
  const a = atom(1);
  const ref = makeDroppedComputed(a);
  await gcUntil(() => ref.deref() === undefined);
  expect(ref.deref()).toBeUndefined();
  a.set(5);
  expect(read(a)).toBe(5);
});

test("a dropped effect disposer reclaims the effect through the FinalizationRegistry", async () => {
  resetEngine();
  const log: string[] = [];
  const a = atom(0, {
    onObserved: () => {
      log.push("observe");
      return () => log.push("unobserve");
    },
  });
  (() => {
    // The disposer is dropped without being called.
    void effect(() => {
      void read(a);
    });
  })();
  await new Promise((res) => setTimeout(res, 1));
  expect(log).toEqual(["observe"]);
  await gcUntil(() => log.includes("unobserve"), 50);
  expect(log).toEqual(["observe", "unobserve"]); // the engine disposed it
  a.set(1); // and no stale effect runs against the freed node
});

test("quiescence: retired episodes and closed passes leave no engine state", async () => {
  resetEngine();
  let ambient: object | null = null;
  setHost({
    currentBatchToken: () => ambient,
    isRendering: () => false,
    deliver: () => {},
  });
  const cells = Array.from({ length: 32 }, (_, i) => atom(i));
  const sums = Array.from({ length: 8 }, (_, i) =>
    computed(() => cells[i * 4]!.get() + cells[i * 4 + 1]!.get()),
  );
  const disposers = sums.map((s) =>
    effect(() => {
      void s.get();
    }),
  );
  // A few episodes with passes over two roots.
  for (let round = 0; round < 5; round++) {
    const token = { round };
    ambient = token;
    const ep = episodeFor(token);
    for (let i = 0; i < 16; i++) cells[i]!.update((x) => x + 1);
    ambient = null;
    const rootA = { rootA: round };
    const rootB = { rootB: round };
    beginPass(rootA, [ep]);
    beginPass(rootB, [ep]);
    cells[20]!.set(round * 100); // urgent mid-pass: exercises MVCC history
    commitPass(rootA, [ep]);
    commitPass(rootB, [ep]);
  }
  await new Promise((res) => setTimeout(res, 1));
  const footprint = debugFootprint();
  expect(footprint.openEpisodes).toBe(0);
  expect(footprint.passFrames).toBe(0);
  expect(footprint.cellsWithHistory).toBe(0);
  expect(footprint.pendingDeliveries).toBe(0);
  expect(footprint.worldCtxOwners).toBe(0);
  for (const d of disposers) d();
  setHost(null);
});

test("unsubscribed nodes drop their committed-view entries at quiescence", async () => {
  resetEngine();
  let ambient: object | null = null;
  setHost({
    currentBatchToken: () => ambient,
    isRendering: () => false,
    deliver: () => {},
  });
  const a = atom(0);
  const rootKey = { root: 1 };
  const sub: Sub = {
    node: a,
    rootKey,
    snapshot: SUB_NEVER,
    cells: null,
    probe: false,
    causeId: 0,
  };
  const { registerSubRoot, unregisterSubRoot } = await import("../src/index");
  const dispose = subscribe(sub);
  registerSubRoot(sub);
  // Screens are only snapshotted while worlds are in play: run one episode.
  const token = {};
  ambient = token;
  const ep = episodeFor(token);
  a.set(1);
  ambient = null;
  beginPass(rootKey, [ep]);
  commitPass(rootKey, [ep]);
  expect(debugFootprint().rootViewEntries).toBeGreaterThan(0); // screen tracked
  dispose();
  unregisterSubRoot(sub);
  await new Promise((res) => setTimeout(res, 1)); // the unsubscribe prune sweeps
  expect(debugFootprint().rootViewEntries).toBe(0); // no subscriber, no copy
  expect(debugFootprint().subs).toBe(0);
  setHost(null);
});
