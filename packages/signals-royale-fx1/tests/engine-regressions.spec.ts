/**
 * Named regressions pinned from oracle fuzz catches. Each test is the shrunk
 * schedule of a real bug, kept as a direct engine test.
 */
import { afterEach, expect, test } from 'vitest';
import {
  atom,
  computed,
  effect,
  setHost,
  resetEngine,
  episodeFor,
  beginPass,
  commitPass,
  frameForRoot,
  peekSlot,
  read,
} from '../src/index';

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

test('oracle seed 1: a pass pinned before a cell grew an update queue keeps its pinned base', () => {
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

test('oracle seed 10: retirement must not collapse a queue out from under a live pass that includes the episode', () => {
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
  const rootHeld = { root: 'held' };
  const rootFast = { root: 'fast' };
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
