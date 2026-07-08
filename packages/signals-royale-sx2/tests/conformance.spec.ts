import { describe, expect, test } from "vitest";
import {
  SkipTest,
  setExpect,
  testSuite,
  type ReactiveFramework,
} from "reactive-framework-test-suite";
import adapter from "../royale/harness-adapter";

const framework: ReactiveFramework = {
  name: adapter.name,
  signal(initialValue) {
    return adapter.signal(initialValue);
  },
  computed(fn) {
    return adapter.computed(fn);
  },
  effect(fn) {
    return adapter.effect(fn);
  },
  run(fn) {
    adapter.effectScope(fn)();
  },
  batch(fn) {
    adapter.startBatch();
    try {
      fn();
    } finally {
      adapter.endBatch();
    }
  },
  untracked: adapter.untracked,
};

setExpect(expect);

for (const { section, cases } of testSuite) {
  describe(`sx2 :: ${section}`, () => {
    for (const [name, fn] of Object.entries(cases)) {
      test(name, () => {
        try {
          framework.run(() => fn(framework));
        } catch (error) {
          if (error instanceof SkipTest) return;
          throw error;
        }
      });
    }
  });
}
