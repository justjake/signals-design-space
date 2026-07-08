/**
 * Named regressions: shrunk schedules of oracle fuzz catches, plus the two
 * judgement-round defects, kept as direct engine tests.
 */
import { afterEach, expect, test } from "vitest";
import {
  atom,
  computed,
  effect,
  latest,
  isPending,
  refresh,
  setHost,
  resetEngine,
  episodeFor,
  beginPass,
  commitPass,
  frameForRoot,
  peekSlot,
  read,
  subscribe,
  Pending,
  SUB_NEVER,
  type Frame,
  type Sub,
} from "../src/index";

let ambient: object | null = null;

function fakeHost(): void {
  setHost({
    currentBatchToken: () => ambient,
    isRendering: () => false,
    deliver: () => {},
  });
}

afterEach(() => {
  ambient = null;
  setHost(null);
  resetEngine();
});

test("oracle seed 1: a pass pinned before a cell grew an update queue keeps its pinned base", () => {
  fakeHost();
  resetEngine();
  const a = atom(17);
  const root = { root: 1 };
  beginPass(root, []); // pin: base of a is 17
  a.set(338); // urgent write after the pin (queue does not exist yet)
  const token = {};
  ambient = token;
  episodeFor(token);
  a.update((x) => x * 2); // first episode op creates the queue at base 338
  ambient = null;
  // The pinned pass must still read 17: the queue's base postdates its pin.
  const frame = frameForRoot(root);
  expect(frame).not.toBeNull();
  expect(peekSlot(a, frame!)).toBe(17);
  expect(read(a)).toBe(338);
});

test("oracle seed 10: retirement must not collapse a queue out from under a live pass that includes the episode", () => {
  fakeHost();
  resetEngine();
  const a = atom(20);
  const b = atom(25);
  const c = atom(51);
  const sum = computed(() => a.get() + b.get() + c.get());
  effect(() => {
    sum.get(); // hot path: canonical cache maintained by marks
  });
  const token = {};
  ambient = token;
  const ep = episodeFor(token);
  a.set(618);
  ambient = null;
  const rootHeld = { root: "held" };
  const rootFast = { root: "fast" };
  beginPass(rootHeld, [ep]);
  beginPass(rootFast, [ep]);
  commitPass(rootFast, [ep]); // retires the episode (no deliveries recorded)
  // rootHeld's pass rendered the episode: it keeps seeing the episode's ops
  // even though retirement folded them into canonical after its pin.
  const frame = frameForRoot(rootHeld);
  expect(frame).not.toBeNull();
  expect(peekSlot(sum, frame!)).toBe(618 + 25 + 51);
  expect(read(sum)).toBe(618 + 25 + 51);
});

// ---------------------------------------------------------------------------
// Judgement-round defects
// ---------------------------------------------------------------------------

const tick = () => new Promise((res) => setTimeout(res, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A rooted subscriber, as the host hooks would create one. */
function rootedSub(node: Sub["node"], rootKey: object): Sub {
  return { node, rootKey, snapshot: SUB_NEVER, cells: null, probe: false, causeId: 0 };
}

test("judgement: latest() inside a host render body resolves that pass's own world", () => {
  let passFrame: Frame | null = null;
  setHost({
    currentBatchToken: () => ambient,
    isRendering: () => false,
    deliver: () => {},
    currentPassFrame: () => passFrame,
  });
  const a = atom(1);
  const token = {};
  ambient = token;
  const ep = episodeFor(token);
  a.update((x) => x + 2); // draft: 3
  ambient = null;
  expect(read(a)).toBe(1);
  expect(latest(a)).toBe(3); // outside any pass: newest intent

  // An urgent pass beside the held draft: its body must see its own world.
  const urgentRoot = { root: "urgent" };
  beginPass(urgentRoot, []);
  passFrame = frameForRoot(urgentRoot);
  expect(peekSlot(a, passFrame!)).toBe(1);
  expect(latest(a)).toBe(1); // not the draft — reading ahead would tear
  passFrame = null;

  // The transition's own pass sees its draft.
  const heldRoot = { root: "held" };
  beginPass(heldRoot, [ep]);
  passFrame = frameForRoot(heldRoot);
  expect(latest(a)).toBe(3);
  passFrame = null;
  expect(latest(a)).toBe(3);
});

/** Every run offers a fresh gate to `use()`; only a run that RESET its fetch
 * slots adopts the new one (a kept slot ignores it). Resolving batches and
 * watching which value lands observes fetch generations, not run counts. */
function fetchable() {
  const gates: Array<{ promise: Promise<string>; resolve: (v: string) => void }> = [];
  const data = computed((use) => {
    const g = deferred<string>();
    gates.push(g);
    return use(g.promise);
  });
  return { data, batch: () => gates.splice(0) };
}

test("judgement: refresh inside a transition refetches in that transition's world; stale serves; the settlement lands with its commit", async () => {
  fakeHost();
  const { data, batch } = fetchable();
  expect(peekSlot(data, null)).toBeInstanceOf(Pending);
  for (const g of batch()) g.resolve("first");
  await tick();
  expect(read(data)).toBe("first");
  batch(); // discard gates offered by settle re-runs (kept slots ignored them)

  // A rooted subscriber keeps the episode open (it has React work to wait for).
  const root = { root: "r" };
  const dispose = subscribe(rootedSub(data, root));
  const token = {};
  ambient = token;
  const ep = episodeFor(token);
  refresh(data); // unchanged inputs — the refetch belongs to this episode
  ambient = null;
  expect(batch()).toHaveLength(0); // no canonical refetch: the world owns it
  expect(read(data)).toBe("first"); // stale keeps serving canonically
  expect(isPending(data)).toBe(true); // newer data is on its way

  // The transition's render pass evaluates the refreshed world: the new
  // fetch generation starts there.
  beginPass(root, [ep]);
  const frame = frameForRoot(root)!;
  expect(peekSlot(data, frame)).toBeInstanceOf(Pending);
  const worldFetch = batch();
  expect(worldFetch.length).toBeGreaterThan(0); // refetch started in the world
  expect(read(data)).toBe("first"); // canonical still stale-serving

  // Settle the world's fetch, then commit: the value lands with the episode.
  for (const g of worldFetch) g.resolve("second");
  await tick();
  expect(read(data)).toBe("first"); // not before the commit
  commitPass(root, [ep]);
  expect(read(data)).toBe("second"); // adopted at retirement: no refetch
  dispose();
});

test("judgement: a transition refresh nothing rendered is carried canonically at retirement", async () => {
  fakeHost();
  const { data, batch } = fetchable();
  expect(peekSlot(data, null)).toBeInstanceOf(Pending);
  for (const g of batch()) g.resolve("first");
  await tick();
  expect(read(data)).toBe("first");
  batch(); // discard settle re-run offers

  const token = {};
  ambient = token;
  refresh(data); // no subscribers: nothing will ever render this episode
  ambient = null;
  expect(batch()).toHaveLength(0); // the world owns the refetch; none ran yet
  await tick(); // undelivered episode auto-retires
  const carried = batch();
  expect(carried.length).toBeGreaterThan(0); // retirement carried the refresh
  expect(read(data)).toBe("first"); // stale serves while it runs
  for (const g of carried) g.resolve("second");
  await tick();
  expect(read(data)).toBe("second");
});
