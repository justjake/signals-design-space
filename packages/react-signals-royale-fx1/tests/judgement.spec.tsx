// @vitest-environment jsdom
/**
 * Judgement-round regressions, real React.
 *
 * 1. latest() called in a render body resolves that pass's own world: an
 *    urgent render beside a held transition must not see the draft.
 * 2. refresh() inside a transition refetches in that transition's world with
 *    unchanged inputs: stale serves meanwhile, the value lands with the
 *    transition's commit.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { atom, computed, read, latest, isPending, refresh, type Use } from "signals-royale-fx1";
import { useValue, useIsPending, startTransitionWrite } from "../src/index";
import { makeHarness, deferred, act, type Harness } from "./helpers";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

test("latest() in a render body is that pass's world: urgent body sees canonical beside a held transition; the transition's body sees its draft", async () => {
  const a = atom(1, { label: "a" });
  const hold = atom(false, { label: "hold" });
  const gate = deferred<null>();
  const holder = computed((use: Use) => {
    if (hold.get()) use(gate.promise);
    return "ready";
  });

  // Every render body records its own world (useValue) beside latest().
  const observed: Array<{ world: number; latest: number }> = [];
  function Probe({ n }: { n: number }) {
    const world = useValue(a);
    observed.push({ world, latest: latest(a) });
    return (
      <span>
        u{n}:{String(world)}
      </span>
    );
  }
  function TransitionReader() {
    const v = useValue(a);
    const held = useValue(holder);
    return (
      <span>
        t:{String(v)}:{held}
      </span>
    );
  }

  let setN!: (n: number) => void;
  function App() {
    const [n, setStateN] = React.useState(0);
    setN = setStateN;
    return (
      <React.Suspense fallback={<i>fb</i>}>
        <Probe n={n} />
        <TransitionReader />
      </React.Suspense>
    );
  }
  const { container } = await h.mount(<App />);
  expect(h.text(container)).toContain("u0:1");

  await act(async () => {
    startTransitionWrite(() => {
      a.update((x) => x + 2);
      hold.set(true);
    });
  });
  expect(read(a)).toBe(1); // draft held: canonical untouched
  expect(latest(a)).toBe(3); // outside render: newest intent

  observed.length = 0;
  await act(() => setN(1)); // urgent re-render during the held transition
  expect(h.text(container)).toContain("u1:1");
  const urgentBodies = observed.filter((o) => o.world === 1);
  expect(urgentBodies.length).toBeGreaterThan(0);
  // The rule, both directions: every pass body — urgent (world 1) and
  // transition (world 3) — resolves latest() to its OWN world.
  for (const o of observed) expect(o.latest).toBe(o.world);

  await act(async () => {
    gate.resolve(null);
    await gate.promise;
  });
  expect(h.text(container)).toContain("u1:3"); // transition landed
  expect(latest(a)).toBe(3);
  expect(read(a)).toBe(3);
});

/** Fetches keyed by nothing: every fetch generation makes a new promise, and
 * resolving a spliced batch shows which generation the slot actually holds. */
function fetchable() {
  const resolvers: Array<(v: string) => void> = [];
  const data = computed((use: Use) => {
    const p = new Promise<string>((res) => resolvers.push(res));
    return use(p);
  });
  return { data, batch: () => resolvers.splice(0) };
}

test("refresh inside a transition refetches with unchanged inputs; stale serves; the value lands with the transition's commit", async () => {
  const { data, batch } = fetchable();
  function Reader() {
    const v = useValue(data);
    const pending = useIsPending(data);
    return (
      <span>
        v:{String(v)};p:{String(pending)}
      </span>
    );
  }
  const { container } = await h.mount(
    <React.Suspense fallback={<i>fb</i>}>
      <Reader />
    </React.Suspense>,
  );
  expect(h.text(container)).toBe("fb");
  await act(async () => {
    for (const r of batch()) r("first");
    await Promise.resolve();
  });
  expect(h.text(container)).toContain("v:first");
  batch(); // discard offers from settle re-runs (kept slots ignored them)

  await act(async () => {
    startTransitionWrite(() => {
      refresh(data);
    });
  });
  const worldFetch = batch();
  expect(worldFetch.length).toBeGreaterThan(0); // a NEW fetch generation started
  expect(h.text(container)).toContain("v:first"); // stale keeps serving
  expect(h.text(container)).not.toContain("fb"); // no fallback flash
  expect(isPending(data)).toBe(true); // engine flags the in-flight refetch
  expect(read(data)).toBe("first"); // canonically stale until the commit

  await act(async () => {
    for (const r of worldFetch) r("second");
    await Promise.resolve();
  });
  expect(h.text(container)).toContain("v:second"); // landed with its commit
  expect(h.text(container)).toContain("p:false");
  expect(read(data)).toBe("second");

  // Un-adopted offers from kept-slot re-runs are zombies: resolving them must
  // change nothing (the commit adopted the settled fetch, it did not refetch).
  await act(async () => {
    for (const r of batch()) r("zombie");
    await Promise.resolve();
  });
  expect(h.text(container)).toContain("v:second");
  expect(read(data)).toBe("second");
});

test("a transition refresh nothing rendered still refetches (carried canonically at retirement)", async () => {
  const { data, batch } = fetchable();
  // Settle a first generation without ever mounting a component.
  expect(isPending(data)).toBe(false);
  refresh(data); // canonical refresh starts the first fetch
  await act(async () => {
    for (const r of batch()) r("first");
    await Promise.resolve();
  });
  expect(read(data)).toBe("first");
  batch();

  await act(async () => {
    startTransitionWrite(() => {
      refresh(data); // no subscriber will ever render this episode
    });
  });
  const carried = batch();
  expect(carried.length).toBeGreaterThan(0); // retirement carried the refetch
  expect(read(data)).toBe("first"); // stale serves while it runs
  await act(async () => {
    for (const r of carried) r("second");
    await Promise.resolve();
  });
  expect(read(data)).toBe("second");
});
